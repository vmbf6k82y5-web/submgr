/**
 * 元数据类接口的集成测试：分类、设置、渠道、提醒规则。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CAT_MEDIA,
  CH_FEISHU,
  CH_TELEGRAM,
  R_DUE_GLOBAL,
  SUB_MONTHLY,
  SUB_TRIAL_FUTURE,
  call,
  callJson,
  makeEnv,
  queryAll,
  queryOne,
  restoreClock,
  scenarioDb,
  useFixedClock,
} from './helpers/scenario.js';
import type { FakeD1 } from './helpers/d1.js';

interface CategoryDto {
  id: string;
  name: string;
  color: string;
  sort: number;
  subscription_count?: number;
}

interface ChannelDto {
  id: string;
  type: string;
  name: string;
  config_json: string;
  config: Record<string, unknown>;
  secret_ref: string | null;
  has_secrets_encrypted: boolean;
}

interface RuleDto {
  id: string;
  rule_type: string;
  subscription_id: string | null;
  days_before: number | null;
  at_time: string | null;
  schedule_type: string | null;
  interval_days: number | null;
  weekdays: number[] | null;
  channel_id: string | null;
  channel_name: string | null;
  enabled: boolean;
}

describe('元数据接口', () => {
  let db: FakeD1;

  beforeEach(() => {
    useFixedClock();
    db = scenarioDb();
  });

  afterEach(() => {
    db.close();
    restoreClock();
  });

  // -------------------------------------------------------------------------
  describe('/api/categories', () => {
    it('列表按 sort 排序并带上订阅数', async () => {
      const env = makeEnv(db);
      const body = await callJson<{ items: CategoryDto[] }>(env, 'GET', '/api/categories');
      expect(body.items.map((c) => c.name)).toEqual(['影音娱乐', '云服务']);
      expect(body.items[0]?.subscription_count).toBe(3);
      expect(body.items[1]?.subscription_count).toBe(1);
    });

    it('新建 / 重名 / 非法颜色', async () => {
      const env = makeEnv(db);
      const created = await callJson<{ item: CategoryDto }>(
        env,
        'POST',
        '/api/categories',
        { name: '软件工具', color: '#8b5cf6', sort: 30 },
        201,
      );
      expect(created.item.color).toBe('#8b5cf6');

      expect((await call(env, 'POST', '/api/categories', { name: '软件工具' })).status).toBe(409);
      expect((await call(env, 'POST', '/api/categories', { name: 'x', color: 'red' })).status).toBe(400);
      expect((await call(env, 'POST', '/api/categories', { name: '  ' })).status).toBe(400);
    });

    it('修改与软删除', async () => {
      const env = makeEnv(db);
      const patched = await callJson<{ item: CategoryDto }>(env, 'PATCH', `/api/categories/${CAT_MEDIA}`, {
        name: '影音',
        sort: 5,
      });
      expect(patched.item.name).toBe('影音');

      await callJson(env, 'DELETE', `/api/categories/${CAT_MEDIA}`);
      const list = await callJson<{ items: CategoryDto[] }>(env, 'GET', '/api/categories');
      expect(list.items.map((c) => c.id)).not.toContain(CAT_MEDIA);

      // 订阅上仍然挂着已删分类的 id，但接口不报错、分类名显示为空
      const subs = await callJson<{ items: { id: string; category_name: string | null }[] }>(
        env,
        'GET',
        '/api/subscriptions',
      );
      const netflix = subs.items.find((s) => s.id === SUB_MONTHLY);
      expect(netflix?.category_name).toBeNull();
    });

    it('PATCH 不存在的分类 -> 404', async () => {
      const env = makeEnv(db);
      expect((await call(env, 'PATCH', '/api/categories/nope', { name: 'x' })).status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe('/api/settings', () => {
    it('GET 返回单行配置与 ICS 路径', async () => {
      const env = makeEnv(db);
      const body = await callJson<{ item: { base_currency: string; timezone: string; ics_token: string; ics_path: string; amortize_lifetime_months: number } }>(
        env,
        'GET',
        '/api/settings',
      );
      expect(body.item.base_currency).toBe('CNY');
      expect(body.item.timezone).toBe('Asia/Shanghai');
      expect(body.item.amortize_lifetime_months).toBe(36);
      expect(body.item.ics_path).toBe(`/ics/${body.item.ics_token}.ics`);
    });

    it('PUT 更新基准币种 / 时区 / 摊销月数', async () => {
      const env = makeEnv(db);
      const body = await callJson<{ item: { base_currency: string; timezone: string; amortize_lifetime_months: number } }>(
        env,
        'PUT',
        '/api/settings',
        { base_currency: 'usd', timezone: 'America/New_York', amortize_lifetime_months: 0 },
      );
      expect(body.item.base_currency).toBe('USD');
      expect(body.item.timezone).toBe('America/New_York');
      expect(body.item.amortize_lifetime_months).toBe(0);
      // 只有一行
      expect(queryAll(db, 'SELECT id FROM settings')).toHaveLength(1);
    });

    it('PUT 非法值 -> 400', async () => {
      const env = makeEnv(db);
      expect((await call(env, 'PUT', '/api/settings', { base_currency: 'RMB!' })).status).toBe(400);
      expect((await call(env, 'PUT', '/api/settings', { timezone: 'Mars/Olympus' })).status).toBe(400);
      expect((await call(env, 'PUT', '/api/settings', { amortize_lifetime_months: -1 })).status).toBe(400);
      expect((await call(env, 'PUT', '/api/settings', { ics_token: 'short' })).status).toBe(400);
      expect((await call(env, 'PUT', '/api/settings', { ics_token: 'has space and 中文' })).status).toBe(400);
      expect((await call(env, 'PUT', '/api/settings', {})).status).toBe(400);
    });

    it('可以显式设置 ics_token，也可以要求重新生成', async () => {
      const env = makeEnv(db);
      const explicit = await callJson<{ item: { ics_token: string } }>(env, 'PUT', '/api/settings', {
        ics_token: 'explicit-token-0123456789',
      });
      expect(explicit.item.ics_token).toBe('explicit-token-0123456789');

      const rotated = await callJson<{ item: { ics_token: string } }>(
        env,
        'POST',
        '/api/settings/reset-ics-token',
      );
      expect(rotated.item.ics_token).not.toBe('explicit-token-0123456789');
      expect(rotated.item.ics_token.length).toBeGreaterThanOrEqual(16);
    });

    it('PUT { reset_ics_token: true } 会换一个新令牌', async () => {
      const env = makeEnv(db);
      const before = await callJson<{ item: { ics_token: string } }>(env, 'GET', '/api/settings');
      const rotated = await callJson<{ item: { ics_token: string } }>(env, 'PUT', '/api/settings', {
        reset_ics_token: true,
      });
      expect(rotated.item.ics_token).not.toBe(before.item.ics_token);
      expect(rotated.item.ics_token).toMatch(/^[0-9a-f]{48}$/);
    });

    it('reset_ics_token 与 ics_token 同时出现 -> 400', async () => {
      const env = makeEnv(db);
      const res = await call(env, 'PUT', '/api/settings', {
        reset_ics_token: true,
        ics_token: 'explicit-token-0123456789',
      });
      expect(res.status).toBe(400);
    });

    it('settings 出现多行未删除时：按最早一行处理并写 warn 日志（不静默）', async () => {
      // singleton 唯一索引 ux_settings_singleton 会拦住正常插入；
      // 这里模拟「数据被手工改乱」的形态：临时摘掉索引，插第二行，再恢复。
      db.raw.exec('DROP INDEX ux_settings_singleton');
      try {
        const now = new Date().toISOString();
        db.raw
          .prepare(
            `INSERT INTO settings (id, base_currency, timezone, ics_token, amortize_lifetime_months, created_at, updated_at)
             VALUES ('00000000-0000-4000-8000-0000000000ff', 'USD', 'UTC', ?, 12, ?, ?)`,
          )
          .run('second-settings-token-0123456789' as never, now as never, now as never);
      } finally {
        // 断言之后再恢复索引：见下方 after-restore 的清理
      }

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      };
      try {
        const env = makeEnv(db);
        const body = await callJson<{ item: { id: string; base_currency: string } }>(
          env,
          'GET',
          '/api/settings',
        );
        // 口径：取最早创建的一行（即 seed 里的原始行）
        expect(body.item.base_currency).toBe('CNY');
        const hit = warnings
          .map((w) => {
            try {
              return JSON.parse(w) as { event?: string; alive_rows?: number };
            } catch {
              return {};
            }
          })
          .find((p) => p.event === 'settings.multiple_alive_rows');
        expect(hit).toBeDefined();
        expect(hit?.alive_rows).toBe(2);
      } finally {
        console.warn = originalWarn;
        // 清理：删掉第二行并恢复 singleton 索引，不影响后续用例
        db.raw.prepare(`DELETE FROM settings WHERE id = ?`).run('00000000-0000-4000-8000-0000000000ff' as never);
        db.raw.exec('CREATE UNIQUE INDEX ux_settings_singleton ON settings ((1))');
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('/api/channels', () => {
    it('列表不回显密文，只告诉有没有密钥', async () => {
      const env = makeEnv(db);
      const body = await callJson<{ items: ChannelDto[] }>(env, 'GET', '/api/channels');
      expect(body.items).toHaveLength(3);
      const telegram = body.items.find((c) => c.id === CH_TELEGRAM) as ChannelDto;
      expect(telegram.secret_ref).toBe('TELEGRAM_TEST');
      expect(telegram.has_secrets_encrypted).toBe(false);
      expect(telegram.config).toEqual({ chat_id: '999' });
      expect(Object.keys(telegram)).not.toContain('secrets_encrypted');
    });

    it('含敏感键名的 config_json 被拒绝（与数据库 CHECK 同一口径）', async () => {
      const env = makeEnv(db);
      const cases = [
        { webhook_url: 'https://x' },
        { bot_token: 'x' },
        { sign_secret: 'x' },
        { secret_key: 'x' },
        { password: 'x' },
      ];
      for (const config of cases) {
        const res = await call(env, 'POST', '/api/channels', {
          type: 'feishu',
          name: `渠道 ${JSON.stringify(config)}`,
          config_json: config,
          secret_ref: 'SOME_SECRET',
        });
        expect(res.status, JSON.stringify(config)).toBe(400);
      }
    });

    it('非敏感配置可以放 config_json（chat_id 不算密钥）', async () => {
      const env = makeEnv(db);
      const created = await callJson<{ item: ChannelDto }>(
        env,
        'POST',
        '/api/channels',
        { type: 'telegram', name: 'TG 备用', config_json: { chat_id: '12345' }, secret_ref: 'TG_BACKUP' },
        201,
      );
      expect(created.item.config).toEqual({ chat_id: '12345' });
    });

    it('必须至少给出 secret_ref 或 secrets_encrypted', async () => {
      const env = makeEnv(db);
      const res = await call(env, 'POST', '/api/channels', { type: 'feishu', name: '没有密钥' });
      expect(res.status).toBe(400);
    });

    it('secret_ref 必须是环境变量名风格（不能是 URL 或 token）', async () => {
      const env = makeEnv(db);
      const res = await call(env, 'POST', '/api/channels', {
        type: 'feishu',
        name: '想直接塞 URL',
        secret_ref: 'https://open.feishu.cn/hook/xxx',
      });
      expect(res.status).toBe(400);
    });

    it('重名 -> 409；修改与软删除', async () => {
      const env = makeEnv(db);
      const dup = await call(env, 'POST', '/api/channels', {
        type: 'feishu',
        name: '飞书 · 测试',
        secret_ref: 'FEISHU_TEST',
      });
      expect(dup.status).toBe(409);

      const patched = await callJson<{ item: ChannelDto }>(env, 'PATCH', `/api/channels/${CH_FEISHU}`, {
        name: '飞书 · 改名',
      });
      expect(patched.item.name).toBe('飞书 · 改名');

      await callJson(env, 'DELETE', `/api/channels/${CH_FEISHU}`);
      const list = await callJson<{ items: ChannelDto[] }>(env, 'GET', '/api/channels');
      expect(list.items.map((c) => c.id)).not.toContain(CH_FEISHU);
    });

    it('PATCH 不能把两个密钥来源同时清空', async () => {
      const env = makeEnv(db);
      const res = await call(env, 'PATCH', `/api/channels/${CH_FEISHU}`, { secret_ref: null });
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  describe('/api/reminders', () => {
    it('列表返回 6 条规则、中文渠道名、weekdays 数组、enabled 布尔', async () => {
      const env = makeEnv(db);
      const body = await callJson<{ items: RuleDto[] }>(env, 'GET', '/api/reminders');
      expect(body.items).toHaveLength(7);
      const weekly = body.items.find((r) => r.id === '55555555-5555-4555-8555-000000000003') as RuleDto;
      expect(weekly.schedule_type).toBe('weekly');
      expect(weekly.weekdays).toHaveLength(1);
      expect(weekly.channel_name).toBe('Telegram · 测试');
      const disabled = body.items.find((r) => r.id === '55555555-5555-4555-8555-000000000005') as RuleDto;
      expect(disabled.enabled).toBe(false);
    });

    it('新建 due 规则', async () => {
      const env = makeEnv(db);
      const body = await callJson<{ item: RuleDto }>(
        env,
        'POST',
        '/api/reminders',
        { rule_type: 'due', days_before: 3, at_time: '08:30', channel_id: CH_FEISHU, subscription_id: SUB_MONTHLY },
        201,
      );
      expect(body.item.days_before).toBe(3);
      expect(body.item.at_time).toBe('08:30');
    });

    it('due 规则必须给出 days_before 与 at_time', async () => {
      const env = makeEnv(db);
      expect((await call(env, 'POST', '/api/reminders', { rule_type: 'due', at_time: '09:00' })).status).toBe(400);
      expect((await call(env, 'POST', '/api/reminders', { rule_type: 'due', days_before: 1 })).status).toBe(400);
      expect(
        (await call(env, 'POST', '/api/reminders', { rule_type: 'due', days_before: 1, at_time: '25:00' })).status,
      ).toBe(400);
      expect(
        (await call(env, 'POST', '/api/reminders', { rule_type: 'due', days_before: 1, at_time: '09:00', weekdays: [1] })).status,
      ).toBe(400);
    });

    it('schedule 规则必须是全局的，且字段与 schedule_type 匹配', async () => {
      const env = makeEnv(db);
      expect(
        (
          await call(env, 'POST', '/api/reminders', {
            rule_type: 'schedule',
            schedule_type: 'weekly',
            at_time: '09:00',
            weekdays: [1],
            subscription_id: SUB_MONTHLY,
          })
        ).status,
      ).toBe(400);

      expect(
        (await call(env, 'POST', '/api/reminders', { rule_type: 'schedule', at_time: '09:00', schedule_type: 'weekly' })).status,
      ).toBe(400);

      expect(
        (
          await call(env, 'POST', '/api/reminders', {
            rule_type: 'schedule',
            at_time: '09:00',
            schedule_type: 'every_n_days',
          })
        ).status,
      ).toBe(400);

      expect(
        (
          await call(env, 'POST', '/api/reminders', {
            rule_type: 'schedule',
            at_time: '09:00',
            schedule_type: 'weekly',
            weekdays: [1, 9],
          })
        ).status,
      ).toBe(400);

      const ok = await callJson<{ item: RuleDto }>(
        env,
        'POST',
        '/api/reminders',
        { rule_type: 'schedule', at_time: '09:00', schedule_type: 'every_n_days', interval_days: 7 },
        201,
      );
      expect(ok.item.interval_days).toBe(7);
      expect(ok.item.subscription_id).toBeNull();
    });

    it('weekdays 也接受 JSON 字符串，并会去重排序', async () => {
      const env = makeEnv(db);
      const body = await callJson<{ item: RuleDto }>(
        env,
        'POST',
        '/api/reminders',
        { rule_type: 'schedule', at_time: '09:00', schedule_type: 'weekly', weekdays: '[3,1,3]' },
        201,
      );
      expect(body.item.weekdays).toEqual([1, 3]);
    });

    it('引用不存在的渠道 / 订阅 -> 400', async () => {
      const env = makeEnv(db);
      expect(
        (await call(env, 'POST', '/api/reminders', { rule_type: 'due', days_before: 1, at_time: '09:00', channel_id: 'nope' })).status,
      ).toBe(400);
      expect(
        (
          await call(env, 'POST', '/api/reminders', {
            rule_type: 'due',
            days_before: 1,
            at_time: '09:00',
            subscription_id: 'nope',
          })
        ).status,
      ).toBe(400);
    });

    it('修改规则（以现值为底合并）', async () => {
      const env = makeEnv(db);
      const body = await callJson<{ item: RuleDto }>(env, 'PATCH', `/api/reminders/${R_DUE_GLOBAL}`, {
        days_before: 2,
        enabled: false,
      });
      expect(body.item.days_before).toBe(2);
      expect(body.item.enabled).toBe(false);
      // 没传的字段保持不变
      expect(body.item.at_time).toBe('09:00');
    });

    it('删除规则（软删除）', async () => {
      const env = makeEnv(db);
      await callJson(env, 'DELETE', `/api/reminders/${R_DUE_GLOBAL}`);
      const row = queryOne<{ deleted_at: string | null }>(
        db,
        'SELECT deleted_at FROM reminder_rules WHERE id = ?',
        R_DUE_GLOBAL,
      );
      expect(row?.deleted_at).not.toBeNull();
      const list = await callJson<{ items: RuleDto[] }>(env, 'GET', '/api/reminders');
      expect(list.items.map((r) => r.id)).not.toContain(R_DUE_GLOBAL);
    });

    it('/api/reminders/log 按到期日倒序返回发送记录', async () => {
      const env = makeEnv(db);
      const body = await callJson<{ items: { rule_id: string; due_date: string; result: string }[] }>(
        env,
        'GET',
        '/api/reminders/log',
      );
      expect(body.items).toEqual([]);
    });

    it('规则详情路径不会吃掉 /log', async () => {
      const env = makeEnv(db);
      const res = await call(env, 'GET', '/api/reminders/log');
      expect(res.status).toBe(200);
    });

    it('试用订阅可以挂到期提醒（配合转正日）', async () => {
      const env = makeEnv(db);
      const body = await callJson<{ item: RuleDto }>(
        env,
        'POST',
        '/api/reminders',
        { rule_type: 'due', days_before: 4, at_time: '09:00', subscription_id: SUB_TRIAL_FUTURE, channel_id: CH_TELEGRAM },
        201,
      );
      expect(body.item.subscription_id).toBe(SUB_TRIAL_FUTURE);
    });
  });
});
