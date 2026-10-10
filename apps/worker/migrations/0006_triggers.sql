-- =============================================================================
-- 订阅管家 / 0006 — 触发器
-- =============================================================================
-- 两类触发器：
--   A. *_touch：任何 UPDATE 如果没有显式改写 updated_at，就自动把它推进到当前时间。
--   B. trg_subscription_versions_freeze：数据库层面的「价格版本冻结」保护。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A. updated_at 自动维护
--    WHEN NEW.updated_at = OLD.updated_at 保证：
--      - 调用方没有显式改 updated_at 时，自动刷新；
--      - 调用方显式写了 updated_at 时，尊重调用方的值，不会覆盖。
-- -----------------------------------------------------------------------------
CREATE TRIGGER trg_settings_touch
AFTER UPDATE ON settings FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE settings SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_categories_touch
AFTER UPDATE ON categories FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE categories SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_subscriptions_touch
AFTER UPDATE ON subscriptions FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE subscriptions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_subscription_versions_touch
AFTER UPDATE ON subscription_versions FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE subscription_versions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_charges_touch
AFTER UPDATE ON charges FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE charges SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_fx_rates_touch
AFTER UPDATE ON fx_rates FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE fx_rates SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE date = NEW.date AND currency = NEW.currency;
END;

CREATE TRIGGER trg_notification_channels_touch
AFTER UPDATE ON notification_channels FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE notification_channels SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_reminder_rules_touch
AFTER UPDATE ON reminder_rules FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE reminder_rules SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_reminder_log_touch
AFTER UPDATE ON reminder_log FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE reminder_log SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- -----------------------------------------------------------------------------
-- B. 价格版本冻结
--    需求：价格版本一旦生效就冻结。涨价或换套餐时必须新建版本；
--          禁止修改已经生效的历史版本的金额、币种和周期。
--
--    「已生效」的判定：OLD.effective_from <= date('now')
--    被冻结的列：amount_minor、currency、cycle_type、cycle_days、
--                effective_from、subscription_id
--    仍可修改：plan_name（改名/修正描述）、deleted_at（软删除）
--
--    注意 IS NOT 而不是 <>，这样 NULL 的变化也能被正确识别。
-- -----------------------------------------------------------------------------
CREATE TRIGGER trg_subscription_versions_freeze
BEFORE UPDATE OF amount_minor, currency, cycle_type, cycle_days, effective_from, subscription_id
ON subscription_versions FOR EACH ROW
WHEN OLD.effective_from <= date('now')
 AND (
      NEW.amount_minor    IS NOT OLD.amount_minor
   OR NEW.currency        IS NOT OLD.currency
   OR NEW.cycle_type      IS NOT OLD.cycle_type
   OR NEW.cycle_days      IS NOT OLD.cycle_days
   OR NEW.effective_from  IS NOT OLD.effective_from
   OR NEW.subscription_id IS NOT OLD.subscription_id
 )
BEGIN
  SELECT RAISE(
    ABORT,
    'subscription_versions 已生效，金额/币种/周期/生效日被冻结：请新建一个版本，不要修改历史版本'
  );
END;
