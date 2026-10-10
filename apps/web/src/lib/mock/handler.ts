/**
 * 示例数据模式下的「迷你 Worker」：路由 + 写入。
 *
 * 覆盖前端真正会调用的接口（读全部 + 会用到的写），
 * 写入直接改进程内状态，所以示例数据模式下页面是可点的、可来回跳的。
 * 没实现的接口一律抛 404 明确说明，而不是假装成功。
 */

import {
  CYCLE_TYPES,
  CHARGE_STATUSES,
  SUB_TYPES,
  CHARGE_CHANNELS,
  RENEW_MODES,
  convertWithFrozenRate,
  frozenRateBetween,
  nowIso,
  type ChargeRow,
  type ChargeStatus,
  type ChargeChannel,
  type CycleType,
  type NotificationChannelRow,
  type RenewMode,
  type SubType,
  type SubscriptionRow,
  type SubscriptionVersionRow,
} from '@submgr/core';
import { ApiError } from '../apiError';
import { mockToday, mockFx, channelDto, chargeDto, chargeListResponse, detailResponse, listResponse, settingsDto, summaryResponse, subscriptionDto, trendsResponse } from './dto';
import { getMockState, type MockScenario, type MockState } from './data';

export interface MockInit {
  body?: unknown;
  query?: Record<string, unknown>;
  scenario: MockScenario;
}

const TREND_DIMENSIONS = ['category', 'cycle', 'channel', 'type'] as const;
type TrendDimension = (typeof TREND_DIMENSIONS)[number];

// ---------------------------------------------------------------------------
// 请求体读取小工具（错误文案与 Worker 的风格保持一致）
// ---------------------------------------------------------------------------

function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError('请求体必须是一个 JSON 对象', 400, 'invalid_body');
  }
  return body as Record<string, unknown>;
}

function optString(body: Record<string, unknown>, key: string): string | null {
  const raw = body[key];
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new ApiError(`字段 ${key} 必须是字符串`, 400, 'invalid_field');
  return raw.trim();
}

function reqString(body: Record<string, unknown>, key: string): string {
  const value = optString(body, key);
  if (value === null) throw new ApiError(`字段 ${key} 是必填的`, 400, 'invalid_field');
  return value;
}

function reqDate(body: Record<string, unknown>, key: string): string {
  const value = reqString(body, key);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(`字段 ${key} 必须是 YYYY-MM-DD`, 400, 'invalid_field');
  }
  return value;
}

function optDate(body: Record<string, unknown>, key: string): string | null {
  const value = optString(body, key);
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(`字段 ${key} 必须是 YYYY-MM-DD`, 400, 'invalid_field');
  }
  return value;
}

function reqInt(body: Record<string, unknown>, key: string, min = 0): number {
  const raw = body[key];
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min) {
    throw new ApiError(`字段 ${key} 必须是不小于 ${min} 的整数`, 400, 'invalid_field');
  }
  return raw;
}

function optInt(body: Record<string, unknown>, key: string, min = 0): number | null {
  const raw = body[key];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min) {
    throw new ApiError(`字段 ${key} 必须是不小于 ${min} 的整数`, 400, 'invalid_field');
  }
  return raw;
}

function reqCurrency(body: Record<string, unknown>, key: string): string {
  const value = reqString(body, key).toUpperCase();
  if (!/^[A-Z]{3}$/.test(value)) {
    throw new ApiError(`字段 ${key} 必须是 3 位字母的币种代码`, 400, 'invalid_field');
  }
  return value;
}

function reqEnum<T extends string>(body: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = reqString(body, key);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ApiError(`字段 ${key} 必须是以下之一：${allowed.join(' / ')}`, 400, 'invalid_field');
  }
  return value as T;
}

function optOptionalString(body: Record<string, unknown>, key: string): string | null {
  return optString(body, key);
}

// ---------------------------------------------------------------------------
// 版本 / 订阅的构造
// ---------------------------------------------------------------------------

function buildVersion(
  subscriptionId: string,
  input: Record<string, unknown>,
  fallbackEffectiveFrom: string,
): SubscriptionVersionRow {
  const cycleType = reqEnum<CycleType>(input, 'cycle_type', CYCLE_TYPES);
  const isTrial = input['is_trial'] === true || input['is_trial'] === 1;
  const cycleDays = optInt(input, 'cycle_days', 1);
  if (cycleType === 'days' && cycleDays === null) {
    throw new ApiError('cycle_type = days 时必须给出 cycle_days', 400, 'invalid_field');
  }
  const version: SubscriptionVersionRow = {
    id: crypto.randomUUID(),
    subscription_id: subscriptionId,
    effective_from: input['effective_from'] === undefined
      ? fallbackEffectiveFrom
      : reqDate(input, 'effective_from'),
    plan_name: optString(input, 'plan_name'),
    amount_minor: reqInt(input, 'amount_minor'),
    currency: reqCurrency(input, 'currency'),
    cycle_type: cycleType,
    cycle_days: cycleType === 'days' ? cycleDays : null,
    is_trial: isTrial ? 1 : 0,
    trial_end_date: null,
    after_trial_amount_minor: null,
    after_trial_currency: null,
    after_trial_cycle_type: null,
    after_trial_cycle_days: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    deleted_at: null,
  };

  if (isTrial) {
    version.trial_end_date = reqDate(input, 'trial_end_date');
    if (version.trial_end_date <= version.effective_from) {
      throw new ApiError('试用结束日必须晚于生效日', 400, 'invalid_field');
    }
    const afterAmount = optInt(input, 'after_trial_amount_minor', 0);
    const afterCycle = input['after_trial_cycle_type'] === undefined || input['after_trial_cycle_type'] === null
      ? null
      : reqEnum<CycleType>(input, 'after_trial_cycle_type', CYCLE_TYPES);
    if (afterAmount !== null && afterCycle !== null) {
      version.after_trial_amount_minor = afterAmount;
      version.after_trial_currency = input['after_trial_currency'] === undefined
        ? version.currency
        : reqCurrency(input, 'after_trial_currency');
      version.after_trial_cycle_type = afterCycle;
      version.after_trial_cycle_days = optInt(input, 'after_trial_cycle_days', 1);
    }
  }

  return version;
}

function assertNoDuplicateDay(state: MockState, subscriptionId: string, effectiveFrom: string): void {
  const duplicate = state.versions.some(
    (v) => v.subscription_id === subscriptionId && v.effective_from === effectiveFrom && !v.deleted_at,
  );
  if (duplicate) {
    throw new ApiError(
      `该订阅在 ${effectiveFrom} 已经有一个版本；要调价请换一个生效日，不要改历史版本`,
      409,
      'duplicate_effective_from',
    );
  }
}

function findSubscription(state: MockState, id: string): SubscriptionRow {
  const sub = state.subscriptions.find((s) => s.id === id && !s.deleted_at);
  if (!sub) throw new ApiError(`订阅不存在或已删除：${id}`, 404, 'not_found');
  return sub;
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export function mockRequest<T>(method: string, path: string, init: MockInit): T {
  const state = getMockState(init.scenario);
  const clean = path.split('?')[0] ?? path;
  const segments = clean.replace(/^\/+|\/+$/g, '').split('/');
  const query = init.query ?? {};
  const verb = method.toUpperCase();

  if (segments[0] !== 'api') {
    throw new ApiError(`示例数据不处理这个路径：${path}`, 404, 'not_found');
  }
  const resource = segments[1];

  // ---- /api/summary ----
  if (resource === 'summary' && verb === 'GET') {
    const windowDays = Number(query['window_days'] ?? 30);
    return { item: summaryResponse(state, Number.isFinite(windowDays) ? windowDays : 30) } as T;
  }

  // ---- /api/trends ----
  if (resource === 'trends' && verb === 'GET') {
    const rawGroup = typeof query['group'] === 'string' ? query['group'] : 'category';
    if (!(TREND_DIMENSIONS as readonly string[]).includes(rawGroup)) {
      throw new ApiError(`查询参数 group 必须是以下之一：${TREND_DIMENSIONS.join(' / ')}`, 400, 'invalid_query');
    }
    const from = typeof query['from'] === 'string' ? query['from'] : undefined;
    const to = typeof query['to'] === 'string' ? query['to'] : undefined;
    return trendsResponse(state, rawGroup as TrendDimension, from, to) as T;
  }

  // ---- /api/settings ----
  if (resource === 'settings') {
    if (segments[2] === 'reset-ics-token' && verb === 'POST') {
      state.settings.ics_token = `demo-${crypto.randomUUID().replace(/-/g, '')}`;
      state.settings.updated_at = nowIso();
      return { item: settingsDto(state) } as T;
    }
    if (segments.length === 2 && verb === 'GET') {
      return { item: settingsDto(state) } as T;
    }
    if (segments.length === 2 && verb === 'PUT') {
      const body = asObject(init.body);
      if (body['base_currency'] !== undefined) {
        const currency = reqCurrency(body, 'base_currency');
        state.settings.base_currency = currency;
      }
      if (body['timezone'] !== undefined) {
        state.settings.timezone = reqString(body, 'timezone');
      }
      if (body['amortize_lifetime_months'] !== undefined) {
        state.settings.amortize_lifetime_months = reqInt(body, 'amortize_lifetime_months', 0);
      }
      if (body['reset_ics_token'] === true) {
        state.settings.ics_token = `demo-${crypto.randomUUID().replace(/-/g, '')}`;
      } else if (body['ics_token'] !== undefined) {
        const token = reqString(body, 'ics_token');
        if (token.length < 16) throw new ApiError('ics_token 至少需要 16 个字符', 400, 'invalid_field');
        state.settings.ics_token = token;
      }
      state.settings.updated_at = nowIso();
      return { item: settingsDto(state) } as T;
    }
  }

  // ---- /api/categories ----
  if (resource === 'categories' && verb === 'GET') {
    const items = state.categories
      .filter((c) => !c.deleted_at)
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
      .map((c) => ({
        ...c,
        subscription_count: state.subscriptions.filter((s) => s.category_id === c.id && !s.deleted_at).length,
      }));
    return { items } as T;
  }

  // ---- /api/channels ----
  if (resource === 'channels') {
    if (segments.length === 2 && verb === 'GET') {
      return { items: state.channels.filter((c) => !c.deleted_at).map((c) => channelDto(state, c.id)) } as T;
    }
    if (segments.length === 2 && verb === 'POST') {
      const body = asObject(init.body);
      const type = reqEnum(body, 'type', ['feishu', 'telegram'] as const);
      const name = reqString(body, 'name');
      const secretRef = optString(body, 'secret_ref');
      const encrypted = optString(body, 'secrets_encrypted');
      if (secretRef === null && encrypted === null) {
        throw new ApiError('必须至少给出 secret_ref 或 secrets_encrypted（密钥不能明文入库，也不能为空）', 400, 'invalid_field');
      }
      if (secretRef !== null && !/^[A-Z][A-Z0-9_]*$/.test(secretRef)) {
        throw new ApiError('secret_ref 只能是环境变量名风格（大写字母、数字、下划线）', 400, 'invalid_field');
      }
      const rawConfig = body['config_json'];
      let configJson = '{}';
      if (typeof rawConfig === 'string' && rawConfig.trim() !== '') {
        try {
          JSON.parse(rawConfig);
        } catch {
          throw new ApiError('config_json 不是合法的 JSON', 400, 'invalid_field');
        }
        configJson = rawConfig;
      } else if (rawConfig !== null && typeof rawConfig === 'object') {
        configJson = JSON.stringify(rawConfig);
      }
      const forbidden = ['"webhook', 'bot_token', 'sign_secret', 'secret_key', 'password'];
      const lower = configJson.toLowerCase();
      for (const needle of forbidden) {
        if (lower.includes(needle)) {
          throw new ApiError(
            `config_json 里不允许出现「${needle.replace(/"/g, '')}」这类敏感键名：密钥必须放 secret_ref 或 secrets_encrypted`,
            400,
            'invalid_field',
          );
        }
      }
      const row: NotificationChannelRow = {
        id: crypto.randomUUID(),
        type,
        name,
        config_json: configJson,
        secret_ref: secretRef,
        secrets_encrypted: encrypted,
        created_at: nowIso(),
        updated_at: nowIso(),
        deleted_at: null,
      };
      state.channels.push(row);
      return { item: channelDto(state, row.id) } as T;
    }
    if (segments.length === 3 && verb === 'DELETE') {
      const channelId = segments[2] ?? '';
      const row = state.channels.find((c) => c.id === channelId && !c.deleted_at);
      if (!row) throw new ApiError(`提醒渠道不存在或已删除：${channelId}`, 404, 'not_found');
      row.deleted_at = nowIso();
      row.updated_at = nowIso();
      return { deleted: true, id: row.id } as T;
    }
  }

  // ---- /api/charges ----
  if (resource === 'charges') {
    if (segments.length === 2 && verb === 'GET') {
      const limit = Number(query['limit'] ?? 100);
      const offset = Number(query['offset'] ?? 0);
      return chargeListResponse(state, {
        subscriptionId: typeof query['subscription_id'] === 'string' ? query['subscription_id'] : undefined,
        from: typeof query['from'] === 'string' ? query['from'] : undefined,
        to: typeof query['to'] === 'string' ? query['to'] : undefined,
        status: typeof query['status'] === 'string' ? query['status'] : undefined,
        limit: Number.isFinite(limit) ? limit : 100,
        offset: Number.isFinite(offset) ? offset : 0,
      }) as T;
    }
    if (segments.length === 2 && verb === 'POST') {
      const body = asObject(init.body);
      const subscriptionId = reqString(body, 'subscription_id');
      findSubscription(state, subscriptionId);
      const chargeDate = reqDate(body, 'charge_date');
      const amountMinor = reqInt(body, 'amount_minor');
      const currency = reqCurrency(body, 'currency');
      const status = body['status'] === undefined
        ? 'paid'
        : reqEnum<ChargeStatus>(body, 'status', CHARGE_STATUSES);
      const versionId = optString(body, 'version_id');

      // 与 Worker 一致：按扣款当天的汇率冻结（示例数据用当前快照）。
      // 注意 USD 是汇率基准，它自己没有快照行 —— 交给 frozenRateBetween 处理。
      const fx = mockFx(state);
      const baseCurrency = state.settings.base_currency;
      const frozenRate = frozenRateBetween(currency, baseCurrency, fx);
      const baseAmount = frozenRate === null
        ? null
        : convertWithFrozenRate(amountMinor, currency, baseCurrency, frozenRate);

      const row: ChargeRow = {
        id: crypto.randomUUID(),
        subscription_id: subscriptionId,
        version_id: versionId,
        charge_date: chargeDate,
        amount_minor: amountMinor,
        currency,
        fx_rate_to_base: frozenRate,
        base_currency: frozenRate === null ? null : baseCurrency,
        base_amount_minor: baseAmount,
        source: 'manual',
        status,
        created_at: nowIso(),
        updated_at: nowIso(),
        deleted_at: null,
      };
      state.charges.push(row);
      return {
        item: chargeDto(state, row),
        fx_warning: frozenRate === null
          ? `缺少 ${currency} 的汇率快照，本笔扣款的基准币种金额留空`
          : null,
      } as T;
    }
    if (segments.length === 3 && verb === 'DELETE') {
      const chargeId = segments[2] ?? '';
      const row = state.charges.find((c) => c.id === chargeId && !c.deleted_at);
      if (!row) throw new ApiError(`扣款记录不存在或已删除：${chargeId}`, 404, 'not_found');
      row.deleted_at = nowIso();
      row.updated_at = nowIso();
      return { deleted: true, id: row.id } as T;
    }
  }

  // ---- /api/subscriptions ----
  if (resource === 'subscriptions') {
    const today = mockToday(state);

    if (segments.length === 2 && verb === 'GET') {
      return listResponse(state, {
        status: typeof query['status'] === 'string' ? query['status'] : undefined,
        q: typeof query['q'] === 'string' ? query['q'] : undefined,
        categoryId: typeof query['category_id'] === 'string' ? query['category_id'] : undefined,
      }) as T;
    }

    if (segments.length === 2 && verb === 'POST') {
      const body = asObject(init.body);
      const startDate = reqDate(body, 'start_date');
      const id = crypto.randomUUID();
      const sub: SubscriptionRow = {
        id,
        name: reqString(body, 'name'),
        category_id: optString(body, 'category_id'),
        sub_type: reqEnum<SubType>(body, 'sub_type', SUB_TYPES),
        charge_channel: reqEnum<ChargeChannel>(body, 'charge_channel', CHARGE_CHANNELS),
        renew_mode: reqEnum<RenewMode>(body, 'renew_mode', RENEW_MODES),
        start_date: startDate,
        end_date: optDate(body, 'end_date'),
        cancelled_at: optString(body, 'cancelled_at'),
        note: optOptionalString(body, 'note'),
        icon: null,
        created_at: nowIso(),
        updated_at: nowIso(),
        deleted_at: null,
      };
      if (sub.end_date !== null && sub.end_date < sub.start_date) {
        throw new ApiError('end_date 不能早于 start_date', 400, 'invalid_field');
      }
      state.subscriptions.push(sub);

      let createdVersionId: string | null = null;
      if (body['version'] !== undefined && body['version'] !== null) {
        const version = buildVersion(id, asObject(body['version']), startDate);
        assertNoDuplicateDay(state, id, version.effective_from);
        state.versions.push(version);
        createdVersionId = version.id;
      }

      return { item: subscriptionDto(state, sub, today), created_version_id: createdVersionId } as T;
    }

    if (segments.length === 3) {
      const sub = findSubscription(state, segments[2] ?? '');

      if (verb === 'GET') {
        return detailResponse(state, sub.id) as T;
      }
      if (verb === 'PATCH') {
        const body = asObject(init.body);
        if (body['name'] !== undefined) sub.name = reqString(body, 'name');
        if (body['category_id'] !== undefined) sub.category_id = optString(body, 'category_id');
        if (body['sub_type'] !== undefined) sub.sub_type = reqEnum<SubType>(body, 'sub_type', SUB_TYPES);
        if (body['charge_channel'] !== undefined) {
          sub.charge_channel = reqEnum<ChargeChannel>(body, 'charge_channel', CHARGE_CHANNELS);
        }
        if (body['renew_mode'] !== undefined) sub.renew_mode = reqEnum<RenewMode>(body, 'renew_mode', RENEW_MODES);
        if (body['start_date'] !== undefined) sub.start_date = reqDate(body, 'start_date');
        if (body['end_date'] !== undefined) sub.end_date = optDate(body, 'end_date');
        if (body['cancelled_at'] !== undefined) sub.cancelled_at = optString(body, 'cancelled_at');
        if (body['note'] !== undefined) sub.note = optOptionalString(body, 'note');
        if (sub.end_date !== null && sub.end_date < sub.start_date) {
          throw new ApiError('end_date 不能早于 start_date', 400, 'invalid_field');
        }
        sub.updated_at = nowIso();
        return {
          item: subscriptionDto(state, sub, today),
          versions: state.versions.filter((v) => v.subscription_id === sub.id && !v.deleted_at),
          charges: state.charges.filter((c) => c.subscription_id === sub.id && !c.deleted_at),
        } as T;
      }
      if (verb === 'DELETE') {
        sub.deleted_at = nowIso();
        sub.updated_at = nowIso();
        for (const v of state.versions) {
          if (v.subscription_id === sub.id && !v.deleted_at) {
            v.deleted_at = nowIso();
            v.updated_at = nowIso();
          }
        }
        return { deleted: true, id: sub.id } as T;
      }
    }

    if (segments.length === 4 && segments[3] === 'versions') {
      const sub = findSubscription(state, segments[2] ?? '');

      if (verb === 'GET') {
        return {
          items: state.versions
            .filter((v) => v.subscription_id === sub.id && !v.deleted_at)
            .sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1))
            .map((v) => ({ ...v, is_trial: v.is_trial === 1, frozen: v.effective_from <= today })),
          today,
        } as T;
      }
      if (verb === 'POST') {
        const body = asObject(init.body);
        const version = buildVersion(sub.id, body, sub.start_date);
        assertNoDuplicateDay(state, sub.id, version.effective_from);
        state.versions.push(version);
        return { item: version, created: true } as T;
      }
    }
  }

  throw new ApiError(
    `示例数据模式还没有实现 ${verb} ${path}；要操作真实数据请在设置里配置 API 与令牌`,
    404,
    'mock_not_implemented',
  );
}
