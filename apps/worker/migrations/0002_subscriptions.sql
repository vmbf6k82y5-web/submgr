-- =============================================================================
-- 订阅管家 / 0002 — subscriptions（订阅主体） + subscription_versions（价格版本）
-- =============================================================================
-- 设计要点：
--   * subscriptions 只放「不随价格变化」的信息。
--   * 价格、币种、周期全部放在 subscription_versions，一旦生效即冻结。
--   * 某个订阅的「当前版本」= effective_from <= 今天 的那些版本里 effective_from
--     最大的那一条（同一天只允许一个版本，见唯一索引）。
--   * 试用到期后，由 Cron 插入一个「转正版本」，其 effective_from = trial_end_date。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- subscriptions
--   sub_type        software | media | cloud | membership | telecom | other
--   charge_channel  纯文字展示用的扣费渠道，不做任何跳转
--                   apple | alipay | wechat | google | card | paypal | telecom | in_app | other
--   renew_mode      auto（自动续费）| manual（手动续费，过期未续会判为异常）
--   start_date      首次订阅日 YYYY-MM-DD，是周期计算锚点
--   end_date        订阅结束日 YYYY-MM-DD，可为空
--   cancelled_at    取消时间（UTC ISO-8601），可为空
-- -----------------------------------------------------------------------------
CREATE TABLE subscriptions (
  id             TEXT PRIMARY KEY NOT NULL,
  name           TEXT NOT NULL,
  category_id    TEXT REFERENCES categories (id) ON DELETE SET NULL,
  sub_type       TEXT NOT NULL,
  charge_channel TEXT NOT NULL,
  renew_mode     TEXT NOT NULL,
  start_date     TEXT NOT NULL,
  end_date       TEXT,
  cancelled_at   TEXT,
  note           TEXT,
  icon           TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at     TEXT,

  CHECK (length(id) = 36),
  CHECK (length(trim(name)) > 0),
  CHECK (sub_type IN ('software', 'media', 'cloud', 'membership', 'telecom', 'other')),
  CHECK (charge_channel IN ('apple', 'alipay', 'wechat', 'google', 'card', 'paypal', 'telecom', 'in_app', 'other')),
  CHECK (renew_mode IN ('auto', 'manual')),
  CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (end_date IS NULL OR end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (cancelled_at IS NULL OR cancelled_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (deleted_at IS NULL OR deleted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);

-- -----------------------------------------------------------------------------
-- subscription_versions —— 价格版本（生效后冻结）
--   effective_from      生效日 YYYY-MM-DD
--   amount_minor        整数，最小单位（分 / 円 / fils ...）
--   currency            ISO 4217，3 位大写
--   cycle_type          month | quarter | half_year | year | days | lifetime
--   cycle_days          仅 cycle_type = 'days' 时填写，必须 > 0
--   is_trial            0/1，是否试用版本
--   trial_end_date      试用结束日 YYYY-MM-DD（is_trial = 1 时必填）
--   after_trial_*       试用结束后的转正价格；为空表示试用后不续费
-- -----------------------------------------------------------------------------
CREATE TABLE subscription_versions (
  id                       TEXT    PRIMARY KEY NOT NULL,
  subscription_id          TEXT    NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
  effective_from           TEXT    NOT NULL,
  plan_name                TEXT,
  amount_minor             INTEGER NOT NULL,
  currency                 TEXT    NOT NULL,
  cycle_type               TEXT    NOT NULL,
  cycle_days               INTEGER,
  is_trial                 INTEGER NOT NULL DEFAULT 0,
  trial_end_date           TEXT,
  after_trial_amount_minor INTEGER,
  after_trial_currency     TEXT,
  after_trial_cycle_type   TEXT,
  after_trial_cycle_days   INTEGER,
  created_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at               TEXT,

  CHECK (length(id) = 36),
  CHECK (effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (amount_minor >= 0),
  CHECK (length(currency) = 3 AND currency = upper(currency)),
  CHECK (cycle_type IN ('month', 'quarter', 'half_year', 'year', 'days', 'lifetime')),

  -- cycle_days 只在 days 周期下存在，且必须为正整数
  CHECK (cycle_type <> 'days' OR (cycle_days IS NOT NULL AND cycle_days > 0)),
  CHECK (cycle_type =  'days' OR cycle_days IS NULL),

  CHECK (is_trial IN (0, 1)),
  -- 试用标记与试用结束日必须成对出现
  CHECK ((is_trial = 1) = (trial_end_date IS NOT NULL)),
  CHECK (trial_end_date IS NULL OR trial_end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (trial_end_date IS NULL OR trial_end_date > effective_from),

  -- 转正价格：金额与币种必须成对出现
  CHECK ((after_trial_amount_minor IS NULL) = (after_trial_currency IS NULL)),
  CHECK (after_trial_amount_minor IS NULL OR after_trial_amount_minor >= 0),
  CHECK (after_trial_currency IS NULL OR (length(after_trial_currency) = 3 AND after_trial_currency = upper(after_trial_currency))),
  CHECK (after_trial_amount_minor IS NULL OR is_trial = 1),
  CHECK (after_trial_currency IS NULL OR is_trial = 1),
  CHECK (after_trial_cycle_type IS NULL OR after_trial_cycle_type IN ('month', 'quarter', 'half_year', 'year', 'days', 'lifetime')),
  CHECK (after_trial_cycle_type IS NULL OR after_trial_amount_minor IS NOT NULL),
  CHECK (after_trial_cycle_type <> 'days' OR (after_trial_cycle_days IS NOT NULL AND after_trial_cycle_days > 0)),
  CHECK (after_trial_cycle_type IS NOT NULL OR after_trial_cycle_days IS NULL),

  CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (deleted_at IS NULL OR deleted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);

-- 同一订阅同一天只能有一个有效版本：保证「当前版本」唯一确定。
CREATE UNIQUE INDEX ux_versions_subscription_effective
  ON subscription_versions (subscription_id, effective_from)
  WHERE deleted_at IS NULL;

CREATE INDEX ix_versions_subscription
  ON subscription_versions (subscription_id, effective_from DESC)
  WHERE deleted_at IS NULL;

-- 试用版本里，trial_end_date 也必须有对应的转正版本，方便 Cron 查找。
CREATE INDEX ix_versions_trial_end
  ON subscription_versions (trial_end_date)
  WHERE is_trial = 1 AND deleted_at IS NULL;
