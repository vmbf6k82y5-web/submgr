#!/usr/bin/env node
/**
 * 用真实的 SQLite 引擎校验 migrations + seed 是否可用。
 *
 * 为什么需要它：阶段一还没有 Cloudflare 账号，但 migration SQL 里的
 * CHECK / 触发器 / 部分唯一索引都必须被真正执行过才算「验证通过」。
 * 这里用 Node 22 内置的 node:sqlite（SQLite 本体，D1 底层也是 SQLite）
 * 把 0001..0006 与 seed.sql 依次执行，并断言关键约束真的会拦人。
 *
 * 用法：
 *   node apps/worker/scripts/validate-schema.mjs
 * 退出码 0 = 全部通过。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// node:sqlite 在 Node 22.5+ 可用（需要 --experimental-sqlite），Node 24+ 默认可用。
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.error(
    [
      '❌ 无法加载 node:sqlite —— 本校验需要 Node.js 22.5 及以上。',
      `   当前版本：${process.version}`,
      '   运行方式：node --experimental-sqlite apps/worker/scripts/validate-schema.mjs',
      '   这只是「在没有 Cloudflare 账号时本地验证 migration SQL」的工具，',
      '   不影响 packages/core 的单元测试。',
    ].join('\n'),
  );
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(here, '..');
const migrationsDir = join(workerRoot, 'migrations');
const seedFile = join(workerRoot, 'seed', 'seed.sql');

let passed = 0;
const failures = [];

function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function fail(name, err) {
  failures.push({ name, err });
  console.log(`  ✗ ${name}\n      ${String(err).split('\n')[0]}`);
}

/** 断言 fn() 抛出异常（用于验证约束确实生效）。 */
function expectThrows(name, fn, match) {
  try {
    fn();
  } catch (err) {
    const msg = String(err.message ?? err);
    if (match && !msg.includes(match)) {
      fail(name, new Error(`抛出了异常但信息不匹配。期望包含 ${JSON.stringify(match)}，实际：${msg}`));
      return;
    }
    ok(name);
    return;
  }
  fail(name, new Error('预期抛出异常，但没有抛出'));
}

/** 断言 fn() 不抛异常。 */
function expectOk(name, fn) {
  try {
    fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

function assertEqual(name, actual, expected) {
  if (actual === expected) {
    ok(name);
  } else {
    fail(name, new Error(`期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`));
  }
}

// ---------------------------------------------------------------------------
// 1. 建立数据库并执行 migrations
// ---------------------------------------------------------------------------
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');

const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

console.log(`\n[1] 执行 ${migrationFiles.length} 个 migration`);
for (const file of migrationFiles) {
  const sql = readFileSync(join(migrationsDir, file), 'utf8');
  try {
    db.exec(sql);
    ok(`${file}`);
  } catch (err) {
    fail(`${file}`, err);
  }
}

if (failures.length > 0) {
  console.error('\n❌ migration 执行失败，后续校验跳过。');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. 执行 seed
// ---------------------------------------------------------------------------
console.log('\n[2] 执行 seed.sql');
try {
  db.exec(readFileSync(seedFile, 'utf8'));
  ok('seed.sql 执行成功');
} catch (err) {
  fail('seed.sql', err);
  console.error('\n❌ seed 执行失败。');
  process.exit(1);
}

const one = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);

// ---------------------------------------------------------------------------
// 3. 数据完整性
// ---------------------------------------------------------------------------
console.log('\n[3] 种子数据完整性');

assertEqual('subscriptions = 5', one('SELECT COUNT(*) AS c FROM subscriptions').c, 5);
assertEqual('subscription_versions = 6', one('SELECT COUNT(*) AS c FROM subscription_versions').c, 6);
assertEqual('charges = 12', one('SELECT COUNT(*) AS c FROM charges').c, 12);
assertEqual('settings = 1', one('SELECT COUNT(*) AS c FROM settings').c, 1);
assertEqual('categories = 5', one('SELECT COUNT(*) AS c FROM categories').c, 5);
assertEqual('reminder_rules = 5', one('SELECT COUNT(*) AS c FROM reminder_rules').c, 5);
assertEqual('notification_channels = 2', one('SELECT COUNT(*) AS c FROM notification_channels').c, 2);
assertEqual('fx_rates = 12', one('SELECT COUNT(*) AS c FROM fx_rates').c, 12);

assertEqual(
  '价格版本覆盖 月付(month)/年付(year)/终身(lifetime)',
  all(`SELECT DISTINCT cycle_type FROM subscription_versions ORDER BY cycle_type`)
    .map((r) => r.cycle_type)
    .join(','),
  'lifetime,month,year',
);

assertEqual(
  '存在一个试用版本（is_trial = 1）',
  one(`SELECT COUNT(*) AS c FROM subscription_versions WHERE is_trial = 1`).c,
  1,
);

assertEqual(
  '试用版本填好了 after_trial 转正价格',
  one(
    `SELECT (after_trial_amount_minor IS NOT NULL AND after_trial_currency IS NOT NULL
             AND after_trial_cycle_type IS NOT NULL) AS ok
       FROM subscription_versions WHERE is_trial = 1`,
  ).ok,
  1,
);

assertEqual(
  '存在外币（非 CNY）版本',
  one(`SELECT COUNT(*) AS c FROM subscription_versions WHERE currency <> 'CNY'`).c,
  1,
);

assertEqual(
  '存在终身（lifetime）版本',
  one(`SELECT COUNT(*) AS c FROM subscription_versions WHERE cycle_type = 'lifetime'`).c,
  1,
);

// 外币扣款确实冻结了汇率与基准金额
const usdCharges = all(
  `SELECT fx_rate_to_base, base_amount_minor, base_currency FROM charges
    WHERE currency = 'USD' ORDER BY charge_date`,
);
assertEqual('USD 扣款有 4 笔', usdCharges.length, 4);
assertEqual(
  'USD 扣款各自冻结了不同汇率（不是同一个值）',
  new Set(usdCharges.map((c) => c.fx_rate_to_base)).size,
  4,
);
assertEqual('USD 扣款基准币种全部冻结为 CNY', new Set(usdCharges.map((c) => c.base_currency)).size, 1);
assertEqual('USD 扣款冻结的是 CNY', usdCharges[0].base_currency, 'CNY');
assertEqual('USD 2299 × 7.1420 = 16419（分）', usdCharges[0].base_amount_minor, 16419);

// 爱奇艺的版本切换
const iqiyiVersions = all(
  `SELECT amount_minor, effective_from FROM subscription_versions
    WHERE subscription_id = '20000000-0000-4000-8000-000000000001'
    ORDER BY effective_from`,
);
assertEqual('爱奇艺有 2 个价格版本', iqiyiVersions.length, 2);
assertEqual('旧版本金额保持 ¥25.00', iqiyiVersions[0].amount_minor, 2500);
assertEqual('新版本金额为 ¥30.00', iqiyiVersions[1].amount_minor, 3000);

// ---------------------------------------------------------------------------
// 4. 约束真的会拦人
// ---------------------------------------------------------------------------
console.log('\n[4] 约束校验');

expectThrows(
  'settings 只允许一行（singleton 唯一索引）',
  () =>
    db
      .prepare(
        `INSERT INTO settings (id, base_currency, timezone, ics_token, amortize_lifetime_months)
         VALUES ('00000000-0000-4000-8000-0000000000ff', 'USD', 'UTC', 'abcdefghijklmnop', 36)`,
      )
      .run(),
  'UNIQUE',
);

expectThrows(
  '已生效版本：改金额被冻结触发器拦下',
  () =>
    db
      .prepare(
        `UPDATE subscription_versions SET amount_minor = 9999
          WHERE id = '30000000-0000-4000-8000-000000000001'`,
      )
      .run(),
  '冻结',
);

expectThrows(
  '已生效版本：改币种被拦下',
  () =>
    db
      .prepare(
        `UPDATE subscription_versions SET currency = 'USD'
          WHERE id = '30000000-0000-4000-8000-000000000001'`,
      )
      .run(),
  '冻结',
);

expectThrows(
  '已生效版本：改周期被拦下',
  () =>
    db
      .prepare(
        `UPDATE subscription_versions SET cycle_type = 'year'
          WHERE id = '30000000-0000-4000-8000-000000000001'`,
      )
      .run(),
  '冻结',
);

expectOk(
  '已生效版本：允许改 plan_name（只是描述）',
  () =>
    db
      .prepare(
        `UPDATE subscription_versions SET plan_name = '黄金会员 · 改名测试'
          WHERE id = '30000000-0000-4000-8000-000000000001'`,
      )
      .run(),
);

expectOk(
  '未生效版本（未来 effective_from）：允许改金额',
  () => {
    db.prepare(
      `INSERT INTO subscription_versions
         (id, subscription_id, effective_from, amount_minor, currency, cycle_type, is_trial)
       VALUES ('30000000-0000-4000-8000-0000000000ff',
               '20000000-0000-4000-8000-000000000001',
               date('now', '+10 days'), 3500, 'CNY', 'month', 0)`,
    ).run();
    db.prepare(
      `UPDATE subscription_versions SET amount_minor = 3600
        WHERE id = '30000000-0000-4000-8000-0000000000ff'`,
    ).run();
    db.prepare(`DELETE FROM subscription_versions WHERE id = '30000000-0000-4000-8000-0000000000ff'`).run();
  },
);

expectThrows(
  '同一订阅同一天不能有两个有效版本',
  () =>
    db
      .prepare(
        `INSERT INTO subscription_versions
           (id, subscription_id, effective_from, amount_minor, currency, cycle_type, is_trial)
         VALUES ('30000000-0000-4000-8000-0000000000fe',
                 '20000000-0000-4000-8000-000000000001',
                 (SELECT effective_from FROM subscription_versions
                   WHERE id = '30000000-0000-4000-8000-000000000001'),
                 100, 'CNY', 'month', 0)`,
      )
      .run(),
  'UNIQUE',
);

expectThrows(
  'cycle_type = days 必须给 cycle_days',
  () =>
    db
      .prepare(
        `INSERT INTO subscription_versions
           (id, subscription_id, effective_from, amount_minor, currency, cycle_type, is_trial)
         VALUES ('30000000-0000-4000-8000-0000000000fd',
                 '20000000-0000-4000-8000-000000000001',
                 date('now', '+20 days'), 100, 'CNY', 'days', 0)`,
      )
      .run(),
  'CHECK',
);

expectThrows(
  'cycle_type 不是 days 时不能给 cycle_days',
  () =>
    db
      .prepare(
        `INSERT INTO subscription_versions
           (id, subscription_id, effective_from, amount_minor, currency, cycle_type, cycle_days, is_trial)
         VALUES ('30000000-0000-4000-8000-0000000000fc',
                 '20000000-0000-4000-8000-000000000001',
                 date('now', '+21 days'), 100, 'CNY', 'month', 30, 0)`,
      )
      .run(),
  'CHECK',
);

expectThrows(
  'Cron 同一天不能为同一订阅重复生成自动扣款（幂等）',
  () =>
    db
      .prepare(
        `INSERT INTO charges
           (id, subscription_id, version_id, charge_date, amount_minor, currency,
            fx_rate_to_base, base_currency, base_amount_minor, source, status)
         VALUES ('40000000-0000-4000-8000-0000000000ff',
                 '20000000-0000-4000-8000-000000000001',
                 '30000000-0000-4000-8000-000000000002',
                 (SELECT charge_date FROM charges WHERE id = '40000000-0000-4000-8000-000000000006'),
                 3000, 'CNY', '1', 'CNY', 3000, 'auto', 'paid')`,
      )
      .run(),
  'UNIQUE',
);

expectThrows(
  '无法冻结金额 = 0 的汇率',
  () =>
    db
      .prepare(
        `INSERT INTO charges
           (id, subscription_id, charge_date, amount_minor, currency, fx_rate_to_base, base_currency, base_amount_minor, source, status)
         VALUES ('40000000-0000-4000-8000-0000000000fe',
                 '20000000-0000-4000-8000-000000000001',
                 date('now'), 100, 'USD', '0', 'CNY', 0, 'manual', 'paid')`,
      )
      .run(),
  'CHECK',
);

expectThrows(
  '汇率表 base 只能是 USD',
  () =>
    db
      .prepare(
        `INSERT INTO fx_rates (date, base, currency, rate, fetched_at)
         VALUES (date('now'), 'CNY', 'USD', '1', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run(),
  'CHECK',
);

expectThrows(
  'notification_channels 不允许明文 webhook 落在 config_json',
  () =>
    db
      .prepare(
        `INSERT INTO notification_channels (id, type, name, config_json, secret_ref)
         VALUES ('50000000-0000-4000-8000-0000000000ff', 'feishu', '明文测试',
                 '{"webhook_url":"https://open.feishu.cn/xxx"}', 'X')`,
      )
      .run(),
  'CHECK',
);

expectThrows(
  'notification_channels 必须给出密钥来源（secret_ref 或密文）',
  () =>
    db
      .prepare(
        `INSERT INTO notification_channels (id, type, name, config_json)
         VALUES ('50000000-0000-4000-8000-0000000000fe', 'telegram', '无密钥', '{}')`,
      )
      .run(),
  'CHECK',
);

expectThrows(
  'reminder_log 同一规则同一到期日只能成功发送一次',
  () => {
    db.prepare(
      `INSERT INTO reminder_log (id, rule_id, subscription_id, due_date, sent_at, result)
       VALUES ('60000000-0000-4000-8000-0000000000ff',
               '60000000-0000-4000-8000-000000000001',
               '20000000-0000-4000-8000-000000000001',
               date('now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'sent')`,
    ).run();
    db.prepare(
      `INSERT INTO reminder_log (id, rule_id, subscription_id, due_date, sent_at, result)
       VALUES ('60000000-0000-4000-8000-0000000000fe',
               '60000000-0000-4000-8000-000000000001',
               '20000000-0000-4000-8000-000000000001',
               date('now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'sent')`,
    ).run();
  },
  'UNIQUE',
);

expectOk(
  'reminder_log 允许对同一 (rule, due_date) 记录多次失败（便于重试）',
  () => {
    db.prepare(
      `INSERT INTO reminder_log (id, rule_id, subscription_id, due_date, sent_at, result)
       VALUES ('60000000-0000-4000-8000-0000000000fd',
               '60000000-0000-4000-8000-000000000002',
               '20000000-0000-4000-8000-000000000001',
               date('now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'failed')`,
    ).run();
    db.prepare(
      `INSERT INTO reminder_log (id, rule_id, subscription_id, due_date, sent_at, result)
       VALUES ('60000000-0000-4000-8000-0000000000fc',
               '60000000-0000-4000-8000-000000000002',
               '20000000-0000-4000-8000-000000000001',
               date('now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'failed')`,
    ).run();
  },
);

expectThrows(
  'schedule 规则的 subscription_id 必须为空（周期汇总是全局的）',
  () =>
    db
      .prepare(
        `INSERT INTO reminder_rules (id, subscription_id, rule_type, at_time, schedule_type, interval_days, channel_id, enabled)
         VALUES ('60000000-0000-4000-8000-0000000000fb',
                 '20000000-0000-4000-8000-000000000001', 'schedule', '09:00', 'every_n_days', 7, NULL, 1)`,
      )
      .run(),
  'CHECK',
);

expectThrows(
  'weekdays 必须是合法 JSON 数组',
  () =>
    db
      .prepare(
        `INSERT INTO reminder_rules (id, subscription_id, rule_type, at_time, schedule_type, weekdays, channel_id, enabled)
         VALUES ('60000000-0000-4000-8000-0000000000fa', NULL, 'schedule', '09:00', 'weekly', 'not-json', NULL, 1)`,
      )
      .run(),
  'CHECK',
);

// ---------------------------------------------------------------------------
// 5. 触发器：updated_at 自动推进 / 显式值不被覆盖
// ---------------------------------------------------------------------------
console.log('\n[5] updated_at 触发器');

const before = one(
  `SELECT updated_at FROM categories WHERE id = '10000000-0000-4000-8000-000000000001'`,
).updated_at;

db.prepare(`UPDATE categories SET name = '影音娱乐（改）' WHERE id = '10000000-0000-4000-8000-000000000001'`).run();
const after = one(
  `SELECT updated_at FROM categories WHERE id = '10000000-0000-4000-8000-000000000001'`,
).updated_at;
assertEqual('未显式改 updated_at 时自动推进', after !== before, true);

const explicit = '2001-01-01T00:00:00.000Z';
db.prepare(
  `UPDATE categories SET name = '影音娱乐（再改）', updated_at = ? WHERE id = '10000000-0000-4000-8000-000000000001'`,
).run(explicit);
assertEqual(
  '显式写入 updated_at 时不被触发器覆盖',
  one(`SELECT updated_at FROM categories WHERE id = '10000000-0000-4000-8000-000000000001'`).updated_at,
  explicit,
);

// ---------------------------------------------------------------------------
// 6. 外键
// ---------------------------------------------------------------------------
console.log('\n[6] 外键');
expectThrows(
  'charges.subscription_id 必须存在',
  () =>
    db
      .prepare(
        `INSERT INTO charges (id, subscription_id, charge_date, amount_minor, currency, source, status)
         VALUES ('40000000-0000-4000-8000-0000000000fd', '99999999-0000-4000-8000-000000000009',
                 date('now'), 100, 'CNY', 'manual', 'paid')`,
      )
      .run(),
  'FOREIGN KEY',
);

expectThrows(
  'reminder_log.rule_id 必须存在',
  () =>
    db
      .prepare(
        `INSERT INTO reminder_log (id, rule_id, due_date, sent_at, result)
         VALUES ('60000000-0000-4000-8000-0000000000f9', '99999999-0000-4000-8000-000000000009',
                 date('now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'sent')`,
      )
      .run(),
  'FOREIGN KEY',
);

// ---------------------------------------------------------------------------
console.log(
  `\n${failures.length === 0 ? '✅' : '❌'} schema 校验：${passed} 通过，${failures.length} 失败\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
