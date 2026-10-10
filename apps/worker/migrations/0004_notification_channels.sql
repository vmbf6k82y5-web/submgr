-- =============================================================================
-- 订阅管家 / 0004 — notification_channels（提醒渠道）
-- =============================================================================
-- 密钥存放规则（需求硬性要求）：密钥不允许明文出现在 D1 里。二选一：
--   * secret_ref        指向 Worker 的 secret / 环境绑定名，例如
--                       'FEISHU_MAIN' / 'TELEGRAM_MAIN'。绑定值是一个 JSON 字符串，
--                       形如 {"webhook_url":"...","sign_secret":"..."}（飞书）
--                       或 {"bot_token":"...","chat_id":"..."}（Telegram）。
--                       Worker 通过 env[secret_ref] 取值，D1 里只有名字。
--   * secrets_encrypted 用部署时注入的主密钥（AES-256-GCM）加密后的密文（base64）。
--                       Worker 用 env.NOTIFY_SECRET_KEY 解密后使用。
-- 两者至少存在一个；config_json 只允许放非敏感配置，并由 CHECK 兜底禁止敏感键名。
-- =============================================================================

CREATE TABLE notification_channels (
  id                TEXT NOT NULL PRIMARY KEY,
  type              TEXT NOT NULL,
  name              TEXT NOT NULL,
  config_json       TEXT NOT NULL DEFAULT '{}',
  secret_ref        TEXT,
  secrets_encrypted TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at        TEXT,

  CHECK (length(id) = 36),
  CHECK (type IN ('feishu', 'telegram')),
  CHECK (length(trim(name)) > 0),

  -- config_json 必须是合法 JSON 对象，且绝不能包含任何敏感键名
  CHECK (json_valid(config_json)),
  CHECK (json_type(config_json) = 'object'),
  CHECK (instr(lower(config_json), '"webhook') = 0),
  CHECK (instr(lower(config_json), 'bot_token') = 0),
  CHECK (instr(lower(config_json), 'sign_secret') = 0),
  CHECK (instr(lower(config_json), 'secret_key') = 0),
  CHECK (instr(lower(config_json), 'password') = 0),

  -- secret_ref 只能是环境变量名风格，不能是 URL / token 本身
  CHECK (secret_ref IS NULL OR secret_ref GLOB '[A-Z][A-Z0-9_]*'),

  -- 必须有密钥来源
  CHECK (secret_ref IS NOT NULL OR secrets_encrypted IS NOT NULL),
  CHECK (secrets_encrypted IS NULL OR length(secrets_encrypted) > 0),

  CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CHECK (deleted_at IS NULL OR deleted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);

CREATE UNIQUE INDEX ux_notification_channels_name
  ON notification_channels (name) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX ux_notification_channels_secret_ref
  ON notification_channels (secret_ref)
  WHERE secret_ref IS NOT NULL AND deleted_at IS NULL;
