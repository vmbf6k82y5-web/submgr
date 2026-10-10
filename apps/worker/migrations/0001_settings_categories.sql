-- =============================================================================
-- 订阅管家 / 0001 — settings（单行配置表） + categories（分类）
-- =============================================================================
-- 全局约定（后续所有 migration 都遵守）：
--   * 所有表主键为 TEXT UUID（v4 小写带连字符）；唯一的例外是 fx_rates，
--     它的主键按需求明确规定为 (date, currency) 复合主键，见 0003。
--   * 每张表都有 created_at / updated_at / deleted_at：
--       - created_at / updated_at 为 UTC ISO-8601 字符串，毫秒可选，必须以 Z 结尾。
--       - deleted_at 为 NULL 表示未删除；软删除用于将来的离线同步（tombstone）。
--   * 所有「时间点」用 UTC ISO-8601（YYYY-MM-DDTHH:MM:SS[.SSS]Z）。
--     所有「日期」用 YYYY-MM-DD（表示用户时区下的自然日，本身不带时区）。
--   * 所有金额为 INTEGER，单位是该币种的最小单位（ISO 4217 exponent）。
--     人民币 25.00 元 => amount_minor = 2500；日元 1200 円 => 1200（exponent 0）。
--     禁止用 REAL / 浮点数存金额。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- settings：全局配置，只允许存在一行（singleton）。
--   base_currency            基准币种，ISO 4217，默认 CNY
--   timezone                 IANA 时区名，默认 Asia/Shanghai
--   ics_token                ICS 订阅地址用的随机令牌，可重置
--   amortize_lifetime_months 终身订阅摊销月数，默认 36；0 表示不摊销
-- -----------------------------------------------------------------------------
CREATE TABLE settings (
  id                       TEXT    PRIMARY KEY NOT NULL,
  base_currency            TEXT    NOT NULL DEFAULT 'CNY',
  timezone                 TEXT    NOT NULL DEFAULT 'Asia/Shanghai',
  ics_token                TEXT    NOT NULL,
  amortize_lifetime_months INTEGER NOT NULL DEFAULT 36,
  created_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at               TEXT,

  CHECK (length(id) = 36),
  CHECK (length(base_currency) = 3 AND base_currency = upper(base_currency)),
  CHECK (length(trim(timezone)) > 0),
  CHECK (length(ics_token) >= 16),
  CHECK (amortize_lifetime_months >= 0),
  CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (deleted_at IS NULL OR deleted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);

-- 单行约束：singleton 恒为 1 且唯一，保证 settings 最多一行。
CREATE UNIQUE INDEX ux_settings_singleton ON settings ((1));
-- 同一个 ics_token 不允许被两行（有效行）同时占用。
CREATE UNIQUE INDEX ux_settings_ics_token ON settings (ics_token) WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- categories：订阅分类
-- -----------------------------------------------------------------------------
CREATE TABLE categories (
  id         TEXT    PRIMARY KEY NOT NULL,
  name       TEXT    NOT NULL,
  color      TEXT    NOT NULL DEFAULT '#64748b',
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,

  CHECK (length(id) = 36),
  CHECK (length(trim(name)) > 0),
  CHECK (color GLOB '#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]'),
  CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (deleted_at IS NULL OR deleted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);

-- 未删除的分类名不允许重复。
CREATE UNIQUE INDEX ux_categories_name ON categories (name) WHERE deleted_at IS NULL;
CREATE INDEX ix_categories_sort ON categories (sort, name) WHERE deleted_at IS NULL;
