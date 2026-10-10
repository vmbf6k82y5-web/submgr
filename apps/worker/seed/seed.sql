-- =============================================================================
-- 订阅管家 / 种子数据（仅用于本地开发与演示，不要在生产库执行）
-- =============================================================================
-- 覆盖 5 种典型形态：月付、年付、试用、终身、外币。
--   1. 爱奇艺黄金会员   月付 CNY，含一次「涨价 → 新建版本」，用于演示价格版本切换
--   2. iCloud+ 2TB      年付 CNY
--   3. Netflix 高级会员  月付 USD（外币），每期扣款冻结了各自的汇率
--   4. Notion Plus      14 天试用，4 天后转正（after_trial 价格已填）
--   5. JetBrains 全家桶  终身买断 CNY，手动续费
--
-- 所有日期都用 date('now', ...) 相对生成，因此无论哪天执行，数据都「看起来是新鲜的」。
-- 执行：
--   pnpm --filter @submgr/worker exec wrangler d1 execute submgr --local \
--     --file=seed/seed.sql
-- =============================================================================

-- 清空（按外键依赖倒序）。⚠️ 会删除现有数据。
DELETE FROM reminder_log;
DELETE FROM reminder_rules;
DELETE FROM charges;
DELETE FROM subscription_versions;
DELETE FROM subscriptions;
DELETE FROM notification_channels;
DELETE FROM categories;
DELETE FROM fx_rates;
DELETE FROM settings;

-- ---------------------------------------------------------------------------
-- settings：单行
-- ---------------------------------------------------------------------------
INSERT INTO settings (id, base_currency, timezone, ics_token, amortize_lifetime_months)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'CNY',
  'Asia/Shanghai',
  lower(hex(randomblob(16))),   -- 随机 ICS 令牌，可在「设置」页重置
  36
);

-- ---------------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------------
INSERT INTO categories (id, name, color, sort) VALUES
  ('10000000-0000-4000-8000-000000000001', '影音娱乐', '#ef4444', 10),
  ('10000000-0000-4000-8000-000000000002', '云服务',   '#0ea5e9', 20),
  ('10000000-0000-4000-8000-000000000003', '软件工具', '#8b5cf6', 30),
  ('10000000-0000-4000-8000-000000000004', '会员服务', '#f59e0b', 40),
  ('10000000-0000-4000-8000-000000000005', '通讯',     '#10b981', 50);

-- ---------------------------------------------------------------------------
-- notification_channels
-- 密钥不入库：secret_ref 指向 Worker 的 secret 绑定名。
--   FEISHU_MAIN   = {"webhook_url":"https://open.feishu.cn/open-apis/bot/v2/hook/xxx","sign_secret":"xxx"}
--   TELEGRAM_MAIN = {"bot_token":"123456:ABC-xxx","chat_id":"123456789"}
-- chat_id 不是密钥，可以放在 config_json 里。飞书则完全没有非敏感配置。
-- ---------------------------------------------------------------------------
INSERT INTO notification_channels (id, type, name, config_json, secret_ref, secrets_encrypted) VALUES
  ('50000000-0000-4000-8000-000000000001', 'feishu',   '飞书 · 订阅提醒', '{}', 'FEISHU_MAIN', NULL),
  ('50000000-0000-4000-8000-000000000002', 'telegram', 'Telegram · 订阅提醒', '{"chat_id":"123456789"}', 'TELEGRAM_MAIN', NULL);

-- ---------------------------------------------------------------------------
-- fx_rates：按天快照，base 固定 USD，rate = 1 USD 等于多少该币种。
-- 这里给今天和昨天各写一份，保证刚播种完不是 stale。
-- 真实运行时由 Cron 每天从汇率源适配器刷新。
-- ---------------------------------------------------------------------------
INSERT INTO fx_rates (date, base, currency, rate, fetched_at) VALUES
  (date('now'), 'USD', 'CNY', '7.1400', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (date('now'), 'USD', 'USD', '1.0000', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (date('now'), 'USD', 'JPY', '157.2000', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (date('now'), 'USD', 'EUR', '0.9200', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (date('now'), 'USD', 'KWD', '0.3065', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (date('now'), 'USD', 'HKD', '7.8000', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO fx_rates (date, base, currency, rate, fetched_at) VALUES
  (date('now', '-1 day'), 'USD', 'CNY', '7.1310', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')),
  (date('now', '-1 day'), 'USD', 'USD', '1.0000', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')),
  (date('now', '-1 day'), 'USD', 'JPY', '156.8500', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')),
  (date('now', '-1 day'), 'USD', 'EUR', '0.9235', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')),
  (date('now', '-1 day'), 'USD', 'KWD', '0.3067', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')),
  (date('now', '-1 day'), 'USD', 'HKD', '7.7990', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'));

-- ---------------------------------------------------------------------------
-- 1. 爱奇艺黄金会员 —— 月付 CNY，微信自动续费，含一次涨价
-- ---------------------------------------------------------------------------
INSERT INTO subscriptions (id, name, category_id, sub_type, charge_channel, renew_mode, start_date, note, icon)
VALUES (
  '20000000-0000-4000-8000-000000000001',
  '爱奇艺黄金会员',
  '10000000-0000-4000-8000-000000000001',
  'media', 'wechat', 'auto',
  date('now', 'start of month', '-5 months'),
  '含一次涨价：第 5 期起 ¥25 → ¥30',
  NULL
);

-- v1：¥25.00 / 月，从第 1 期开始
INSERT INTO subscription_versions
  (id, subscription_id, effective_from, plan_name, amount_minor, currency, cycle_type, cycle_days, is_trial)
VALUES (
  '30000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  date('now', 'start of month', '-5 months'),
  '黄金会员 · 连续包月',
  2500, 'CNY', 'month', NULL, 0
);

-- v2：¥30.00 / 月，从上个月 1 号起生效（涨价 => 新建版本，历史版本保持冻结）
INSERT INTO subscription_versions
  (id, subscription_id, effective_from, plan_name, amount_minor, currency, cycle_type, cycle_days, is_trial)
VALUES (
  '30000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000001',
  date('now', 'start of month', '-1 months'),
  '黄金会员 · 连续包月（调价后）',
  3000, 'CNY', 'month', NULL, 0
);

-- 对应扣款：前 4 期走 v1（¥25），后 2 期走 v2（¥30）。基准币种就是 CNY，汇率恒为 1。
INSERT INTO charges
  (id, subscription_id, version_id, charge_date, amount_minor, currency, fx_rate_to_base, base_currency, base_amount_minor, source, status)
VALUES
  ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', date('now','start of month','-5 months'), 2500, 'CNY', '1', 'CNY', 2500, 'auto', 'paid'),
  ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', date('now','start of month','-4 months'), 2500, 'CNY', '1', 'CNY', 2500, 'auto', 'paid'),
  ('40000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', date('now','start of month','-3 months'), 2500, 'CNY', '1', 'CNY', 2500, 'auto', 'paid'),
  ('40000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', date('now','start of month','-2 months'), 2500, 'CNY', '1', 'CNY', 2500, 'auto', 'paid'),
  ('40000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', date('now','start of month','-1 months'), 3000, 'CNY', '1', 'CNY', 3000, 'auto', 'paid'),
  ('40000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', date('now','start of month'),                 3000, 'CNY', '1', 'CNY', 3000, 'auto', 'paid');

-- ---------------------------------------------------------------------------
-- 2. iCloud+ 2TB —— 年付 CNY，Apple 自动续费
--    起始日往前 11 个月 => 下一个周年日在 1 个月后
-- ---------------------------------------------------------------------------
INSERT INTO subscriptions (id, name, category_id, sub_type, charge_channel, renew_mode, start_date, note, icon)
VALUES (
  '20000000-0000-4000-8000-000000000002',
  'iCloud+ 2TB',
  '10000000-0000-4000-8000-000000000002',
  'cloud', 'apple', 'auto',
  date('now', '-11 months', 'start of month'),
  '年付，下个周年日在 1 个月后',
  NULL
);

INSERT INTO subscription_versions
  (id, subscription_id, effective_from, plan_name, amount_minor, currency, cycle_type, cycle_days, is_trial)
VALUES (
  '30000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000002',
  date('now', '-11 months', 'start of month'),
  'iCloud+ 2TB 年付',
  81600, 'CNY', 'year', NULL, 0
);

INSERT INTO charges
  (id, subscription_id, version_id, charge_date, amount_minor, currency, fx_rate_to_base, base_currency, base_amount_minor, source, status)
VALUES
  ('40000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003', date('now','-11 months','start of month'), 81600, 'CNY', '1', 'CNY', 81600, 'auto', 'paid');

-- ---------------------------------------------------------------------------
-- 3. Netflix 高级会员 —— 月付 USD（外币）
--    每期扣款用「扣款当天」的汇率换算成 CNY 并冻结，所以四期汇率各不相同。
-- ---------------------------------------------------------------------------
INSERT INTO subscriptions (id, name, category_id, sub_type, charge_channel, renew_mode, start_date, note, icon)
VALUES (
  '20000000-0000-4000-8000-000000000003',
  'Netflix 高级会员',
  '10000000-0000-4000-8000-000000000001',
  'media', 'card', 'auto',
  date('now', 'start of month', '-3 months'),
  '外币订阅，扣款时冻结汇率',
  NULL
);

INSERT INTO subscription_versions
  (id, subscription_id, effective_from, plan_name, amount_minor, currency, cycle_type, cycle_days, is_trial)
VALUES (
  '30000000-0000-4000-8000-000000000004',
  '20000000-0000-4000-8000-000000000003',
  date('now', 'start of month', '-3 months'),
  'Premium 4K',
  2299, 'USD', 'month', NULL, 0
);

-- base_amount_minor 用 CAST(round(amount_minor * fx_rate) AS INTEGER) 计算，
-- 与 packages/core 的 convert() 采用同一套「最小单位 × 汇率后四舍五入」规则。
INSERT INTO charges
  (id, subscription_id, version_id, charge_date, amount_minor, currency, fx_rate_to_base, base_currency, base_amount_minor, source, status)
VALUES
  ('40000000-0000-4000-8000-000000000008', '20000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000004', date('now','start of month','-3 months'), 2299, 'USD', '7.1420', 'CNY', CAST(round(2299 * 7.1420) AS INTEGER), 'auto', 'paid'),
  ('40000000-0000-4000-8000-000000000009', '20000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000004', date('now','start of month','-2 months'), 2299, 'USD', '7.0980', 'CNY', CAST(round(2299 * 7.0980) AS INTEGER), 'auto', 'paid'),
  ('40000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000004', date('now','start of month','-1 months'), 2299, 'USD', '7.2150', 'CNY', CAST(round(2299 * 7.2150) AS INTEGER), 'auto', 'paid'),
  ('40000000-0000-4000-8000-00000000000b', '20000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000004', date('now','start of month'),                 2299, 'USD', '7.1690', 'CNY', CAST(round(2299 * 7.1690) AS INTEGER), 'auto', 'paid');

-- ---------------------------------------------------------------------------
-- 4. Notion Plus —— 14 天试用，4 天后转正
--    试用版本 amount_minor = 0；after_trial_* 描述转正后的价格。
--    Cron 会在 trial_end_date 当天插入一个 effective_from = trial_end_date 的转正版本。
-- ---------------------------------------------------------------------------
INSERT INTO subscriptions (id, name, category_id, sub_type, charge_channel, renew_mode, start_date, note, icon)
VALUES (
  '20000000-0000-4000-8000-000000000004',
  'Notion Plus',
  '10000000-0000-4000-8000-000000000003',
  'software', 'card', 'auto',
  date('now', '-10 days'),
  '14 天试用，4 天后自动转正为 ¥99.00/月',
  NULL
);

INSERT INTO subscription_versions
  (id, subscription_id, effective_from, plan_name, amount_minor, currency, cycle_type, cycle_days,
   is_trial, trial_end_date, after_trial_amount_minor, after_trial_currency, after_trial_cycle_type, after_trial_cycle_days)
VALUES (
  '30000000-0000-4000-8000-000000000005',
  '20000000-0000-4000-8000-000000000004',
  date('now', '-10 days'),
  'Plus 试用',
  0, 'CNY', 'month', NULL,
  1, date('now', '+4 days'), 9900, 'CNY', 'month', NULL
);

-- ---------------------------------------------------------------------------
-- 5. JetBrains 全家桶 —— 终身买断 CNY，手动续费（无自动扣款）
--    月均按 settings.amortize_lifetime_months = 36 摊销。
-- ---------------------------------------------------------------------------
INSERT INTO subscriptions (id, name, category_id, sub_type, charge_channel, renew_mode, start_date, note, icon)
VALUES (
  '20000000-0000-4000-8000-000000000005',
  'JetBrains 全家桶',
  '10000000-0000-4000-8000-000000000003',
  'software', 'alipay', 'manual',
  date('now', '-2 years'),
  '终身买断，一次性付费，按 36 个月摊销',
  NULL
);

INSERT INTO subscription_versions
  (id, subscription_id, effective_from, plan_name, amount_minor, currency, cycle_type, cycle_days, is_trial)
VALUES (
  '30000000-0000-4000-8000-000000000006',
  '20000000-0000-4000-8000-000000000005',
  date('now', '-2 years'),
  'All Products Pack · 永久授权',
  214800, 'CNY', 'lifetime', NULL, 0
);

INSERT INTO charges
  (id, subscription_id, version_id, charge_date, amount_minor, currency, fx_rate_to_base, base_currency, base_amount_minor, source, status)
VALUES
  ('40000000-0000-4000-8000-00000000000c', '20000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000006', date('now','-2 years'), 214800, 'CNY', '1', 'CNY', 214800, 'manual', 'paid');

-- ---------------------------------------------------------------------------
-- reminder_rules
-- ---------------------------------------------------------------------------
INSERT INTO reminder_rules (id, subscription_id, rule_type, days_before, at_time, schedule_type, interval_days, weekdays, channel_id, enabled) VALUES
  -- 全局：所有订阅到期前 1 天 09:00 提醒
  ('60000000-0000-4000-8000-000000000001', NULL, 'due', 1, '09:00', NULL, NULL, NULL, '50000000-0000-4000-8000-000000000001', 1),
  -- 爱奇艺单独：到期当天 10:00 再提醒一次
  ('60000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'due', 0, '10:00', NULL, NULL, NULL, '50000000-0000-4000-8000-000000000001', 1),
  -- Notion 试用：试用结束前 3 天提醒（避免「默默转正」）
  ('60000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000004', 'due', 3, '09:00', NULL, NULL, NULL, '50000000-0000-4000-8000-000000000002', 1),
  -- 周期汇总：每周一 09:30 发一次汇总
  ('60000000-0000-4000-8000-000000000004', NULL, 'schedule', NULL, '09:30', 'weekly', NULL, '[1]', '50000000-0000-4000-8000-000000000001', 1),
  -- 周期汇总：每 15 天一次
  ('60000000-0000-4000-8000-000000000005', NULL, 'schedule', NULL, '09:30', 'every_n_days', 15, NULL, '50000000-0000-4000-8000-000000000002', 0);
