-- =============================================================================
-- 订阅管家 / 0005 — reminder_rules（提醒规则） + reminder_log（发送去重日志）
-- =============================================================================
-- 本表承载两类规则，用 rule_type 区分（需求里把第二类描述为「另外单独一种」）：
--
--   rule_type = 'due'      到期提醒：在「到期日前 days_before 天」的 at_time 发送。
--                          subscription_id 为 NULL 表示全局规则，适用于所有订阅。
--                          days_before = 0 表示到期当天提醒，1 表示提前一天。
--
--   rule_type = 'schedule' 周期汇总提醒：每 interval_days 天一次，
--                          或每周的 weekdays（JSON 数组，1=周一 … 7=周日，ISO-8601）
--                          的 at_time 发送一次汇总。
--
-- at_time 一律按 settings.timezone 解释，格式 HH:mm（24 小时制）。
-- =============================================================================

CREATE TABLE reminder_rules (
  id              TEXT    PRIMARY KEY NOT NULL,
  subscription_id TEXT    REFERENCES subscriptions (id) ON DELETE CASCADE,
  rule_type       TEXT    NOT NULL DEFAULT 'due',
  days_before     INTEGER,
  at_time         TEXT,
  schedule_type   TEXT,
  interval_days   INTEGER,
  weekdays        TEXT,
  channel_id      TEXT    REFERENCES notification_channels (id) ON DELETE SET NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at      TEXT,

  CHECK (length(id) = 36),
  CHECK (rule_type IN ('due', 'schedule')),
  CHECK (enabled IN (0, 1)),
  CHECK (at_time IS NULL OR at_time GLOB '[0-2][0-9]:[0-5][0-9]'),

  -- 'due' 规则必须有 days_before 与 at_time
  CHECK (rule_type <> 'due' OR (days_before IS NOT NULL AND at_time IS NOT NULL)),
  CHECK (days_before IS NULL OR days_before >= 0),

  -- 'schedule' 规则必须有 schedule_type 与 at_time
  CHECK (rule_type <> 'schedule' OR (schedule_type IS NOT NULL AND at_time IS NOT NULL)),
  CHECK (schedule_type IS NULL OR schedule_type IN ('every_n_days', 'weekly')),
  CHECK (schedule_type IS NULL OR rule_type = 'schedule'),

  -- every_n_days 必须有正整数 interval_days；weekly 必须有 weekdays
  CHECK (schedule_type <> 'every_n_days' OR (interval_days IS NOT NULL AND interval_days > 0)),
  CHECK (schedule_type <> 'weekly' OR weekdays IS NOT NULL),
  CHECK (interval_days IS NULL OR (schedule_type = 'every_n_days' AND interval_days > 0)),

  -- weekdays 必须是合法 JSON 数组，元素为 1..7 的整数
  CHECK (weekdays IS NULL OR (json_valid(weekdays) AND json_type(weekdays) = 'array')),

  -- 周期汇总规则是全局的，不挂在单个订阅上
  CHECK (rule_type <> 'schedule' OR subscription_id IS NULL),

  CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (deleted_at IS NULL OR deleted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);

CREATE INDEX ix_reminder_rules_subscription
  ON reminder_rules (subscription_id, rule_type) WHERE deleted_at IS NULL;

CREATE INDEX ix_reminder_rules_enabled
  ON reminder_rules (enabled, rule_type) WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- reminder_log —— 去重日志
--   rule_id          触发它的规则
--   subscription_id  相关订阅（周期汇总规则为 NULL）
--   due_date         该次提醒对应的「到期日 / 本次汇总日期」(YYYY-MM-DD)，去重键
--   sent_at          实际发送时刻（UTC ISO-8601）
--   result           sent | failed | skipped
-- 唯一索引只覆盖 result = 'sent'：发送成功过就永不重发，
-- 失败的记录可以重试并留下多条历史。
-- -----------------------------------------------------------------------------
CREATE TABLE reminder_log (
  id              TEXT PRIMARY KEY NOT NULL,
  rule_id         TEXT NOT NULL REFERENCES reminder_rules (id) ON DELETE CASCADE,
  subscription_id TEXT REFERENCES subscriptions (id) ON DELETE CASCADE,
  due_date        TEXT NOT NULL,
  sent_at         TEXT,
  result          TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at      TEXT,

  CHECK (length(id) = 36),
  CHECK (due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (result IN ('sent', 'failed', 'skipped')),
  CHECK (result <> 'sent' OR sent_at IS NOT NULL),
  CHECK (sent_at IS NULL OR sent_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (deleted_at IS NULL OR deleted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);

CREATE UNIQUE INDEX ux_reminder_log_dedupe
  ON reminder_log (rule_id, due_date)
  WHERE result = 'sent' AND deleted_at IS NULL;

CREATE INDEX ix_reminder_log_due_date
  ON reminder_log (due_date DESC);

CREATE INDEX ix_reminder_log_subscription
  ON reminder_log (subscription_id, due_date DESC);
