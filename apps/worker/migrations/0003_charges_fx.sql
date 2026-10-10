-- =============================================================================
-- 订阅管家 / 0003 — charges（扣款记录） + fx_rates（每日汇率快照）
-- =============================================================================
-- 金额与汇率约定：
--   * amount_minor        原币金额，整数最小单位。
--   * currency            原币 ISO 4217。
--   * fx_rate_to_base     1 单位 currency 等于多少单位 base_currency，用字符串存
--                         （例如 USD -> CNY 时为 '7.1234'），避免浮点误差。
--   * base_currency       冻结时的基准币种（settings.base_currency 之后可能被改，
--                         不记下来的话 base_amount_minor 就失去意义）。
--   * base_amount_minor   冻结的基准币种金额，整数最小单位。
--   规则：已经发生的扣款用「扣款当天」的汇率换算并冻结；只有未来预估才用最新汇率。
-- =============================================================================

CREATE TABLE charges (
  id               TEXT    PRIMARY KEY NOT NULL,
  subscription_id  TEXT    NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
  version_id       TEXT    REFERENCES subscription_versions (id) ON DELETE SET NULL,
  charge_date      TEXT    NOT NULL,
  amount_minor     INTEGER NOT NULL,
  currency         TEXT    NOT NULL,
  fx_rate_to_base  TEXT,
  base_currency    TEXT,
  base_amount_minor INTEGER,
  source           TEXT    NOT NULL,
  status           TEXT    NOT NULL,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at       TEXT,

  CHECK (length(id) = 36),
  CHECK (charge_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (amount_minor >= 0),
  CHECK (length(currency) = 3 AND currency = upper(currency)),
  CHECK (base_currency IS NULL OR (length(base_currency) = 3 AND base_currency = upper(base_currency))),
  CHECK (source IN ('auto', 'manual')),
  CHECK (status IN ('paid', 'failed', 'refunded')),

  -- 汇率必须是正的十进制字符串
  CHECK (fx_rate_to_base IS NULL OR (fx_rate_to_base GLOB '*[0-9]*' AND CAST(fx_rate_to_base AS REAL) > 0)),
  -- 冻结后的基准金额必须能追溯到汇率与币种
  CHECK (base_amount_minor IS NULL OR (fx_rate_to_base IS NOT NULL AND base_currency IS NOT NULL)),
  CHECK (base_amount_minor IS NULL OR base_amount_minor >= 0),
  CHECK (base_currency IS NULL OR fx_rate_to_base IS NOT NULL),

  CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (deleted_at IS NULL OR deleted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);

-- 幂等保护：Cron 每天最多为「同一个订阅的同一天」自动生成一条扣款。
-- 手动修正的记录（source = 'manual'）不受此限制。
CREATE UNIQUE INDEX ux_charges_auto_daily
  ON charges (subscription_id, charge_date)
  WHERE source = 'auto' AND deleted_at IS NULL;

CREATE INDEX ix_charges_subscription_date
  ON charges (subscription_id, charge_date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX ix_charges_date
  ON charges (charge_date)
  WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- fx_rates —— 按天存的汇率快照，base 固定 USD。
--   rate       1 USD 等于多少 currency（与 https://open.er-api.com/v6/latest/USD
--              的语义一致），用字符串存。
--   fetched_at 实际抓取时刻（UTC ISO-8601）；stale 判定基于它而不是 date，
--              因为 date 只有天粒度，无法判断是否「超过 48 小时」。
--
-- 注意：按需求规定，本表主键是 (date, currency) 复合主键，
--       这是「所有表主键都用 UUID」这条通用规则的唯一例外。
-- -----------------------------------------------------------------------------
CREATE TABLE fx_rates (
  date       TEXT NOT NULL,
  base       TEXT NOT NULL DEFAULT 'USD',
  currency   TEXT NOT NULL,
  rate       TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,

  PRIMARY KEY (date, currency),

  CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (base = 'USD'),
  CHECK (length(currency) = 3 AND currency = upper(currency)),
  CHECK (rate GLOB '*[0-9]*' AND CAST(rate AS REAL) > 0),
  CHECK (fetched_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (deleted_at IS NULL OR deleted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);

-- 取「每个币种最新一天」的汇率时用；也是 stale 判定的依据。
CREATE INDEX ix_fx_rates_currency_date ON fx_rates (currency, date DESC);
CREATE INDEX ix_fx_rates_fetched_at ON fx_rates (fetched_at DESC);
