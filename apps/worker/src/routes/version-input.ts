/**
 * subscription_versions 的请求体解析与形状校验。
 *
 * 抽出来独立成文件的原因：创建订阅时可以顺带带上首个版本，
 * 因此 subscriptions 路由与 versions 路由共用同一套校验，
 * 保证「接口层接受的值」= 「migration 里 CHECK 接受的值」，
 * 让用户在 400 里看到中文字段名，而不是 D1 的 CHECK constraint failed。
 */

import { CYCLE_TYPES, compareDateOnly, type CycleType, type SubscriptionVersionRow } from '@submgr/core';
import { invalid } from '../lib/errors.js';
import {
  has,
  optionalBool,
  optionalCurrency,
  optionalDateOnly,
  optionalEnum,
  optionalInt,
  optionalString,
  requiredCurrency,
  requiredDateOnly,
  requiredEnum,
  requiredInt,
  type JsonObject,
} from '../lib/validate.js';

/** 一个完整、已经过形状校验的版本（字段名与 D1 列一一对应）。 */
export interface VersionInput {
  effective_from: string;
  plan_name: string | null;
  amount_minor: number;
  currency: string;
  cycle_type: CycleType;
  cycle_days: number | null;
  is_trial: 0 | 1;
  trial_end_date: string | null;
  after_trial_amount_minor: number | null;
  after_trial_currency: string | null;
  after_trial_cycle_type: CycleType | null;
  after_trial_cycle_days: number | null;
}

/** 订阅的版本字段从「请求体 + 现值」取值：create 时现值为 undefined。 */
function readFields(body: JsonObject, current?: SubscriptionVersionRow): VersionInput {
  const effective_from = has(body, 'effective_from')
    ? requiredDateOnly(body, 'effective_from')
    : current?.effective_from;

  if (effective_from === undefined) {
    throw invalid('字段 effective_from 是必填的（YYYY-MM-DD）');
  }

  const plan_name = has(body, 'plan_name')
    ? (optionalString(body, 'plan_name', { max: 200 }) ?? null)
    : (current?.plan_name ?? null);

  let amount_minor: number;
  if (has(body, 'amount_minor')) amount_minor = requiredInt(body, 'amount_minor', { min: 0 });
  else if (current) amount_minor = current.amount_minor;
  else throw invalid('字段 amount_minor 是必填的（整数最小单位）');

  let currency: string;
  if (has(body, 'currency')) currency = requiredCurrency(body, 'currency');
  else if (current) currency = current.currency;
  else throw invalid('字段 currency 是必填的（ISO 4217，3 位大写字母）');

  let cycle_type: CycleType;
  if (has(body, 'cycle_type')) cycle_type = requiredEnum(body, 'cycle_type', CYCLE_TYPES);
  else if (current) cycle_type = current.cycle_type;
  else throw invalid(`字段 cycle_type 是必填的：${CYCLE_TYPES.join(' / ')}`);

  const cycle_days = has(body, 'cycle_days')
    ? (optionalInt(body, 'cycle_days', { min: 1 }) ?? null)
    : (current?.cycle_days ?? null);

  const is_trial: 0 | 1 = has(body, 'is_trial')
    ? (optionalBool(body, 'is_trial') === true ? 1 : 0)
    : (current ? (current.is_trial === 1 || current.is_trial === true ? 1 : 0) : 0);

  const trial_end_date = has(body, 'trial_end_date')
    ? (optionalDateOnly(body, 'trial_end_date') ?? null)
    : (current?.trial_end_date ?? null);

  const after_trial_amount_minor = has(body, 'after_trial_amount_minor')
    ? (optionalInt(body, 'after_trial_amount_minor', { min: 0 }) ?? null)
    : (current?.after_trial_amount_minor ?? null);

  const after_trial_currency = has(body, 'after_trial_currency')
    ? (optionalCurrency(body, 'after_trial_currency') ?? null)
    : (current?.after_trial_currency ?? null);

  const after_trial_cycle_type = has(body, 'after_trial_cycle_type')
    ? (optionalEnum(body, 'after_trial_cycle_type', CYCLE_TYPES) ?? null)
    : (current?.after_trial_cycle_type ?? null);

  const after_trial_cycle_days = has(body, 'after_trial_cycle_days')
    ? (optionalInt(body, 'after_trial_cycle_days', { min: 1 }) ?? null)
    : (current?.after_trial_cycle_days ?? null);

  return validateVersionShape({
    effective_from,
    plan_name,
    amount_minor,
    currency,
    cycle_type,
    cycle_days,
    is_trial,
    trial_end_date,
    after_trial_amount_minor,
    after_trial_currency,
    after_trial_cycle_type,
    after_trial_cycle_days,
  });
}

/** 创建：所有必填字段必须出现。 */
export function readVersionCreate(body: JsonObject, defaultEffectiveFrom: string): VersionInput {
  const withDefault: JsonObject = has(body, 'effective_from')
    ? body
    : { ...body, effective_from: defaultEffectiveFrom };
  return readFields(withDefault);
}

/** 修改：以现值为底，只覆盖请求里出现的字段，然后整体重新校验。 */
export function readVersionPatch(body: JsonObject, current: SubscriptionVersionRow): VersionInput {
  return readFields(body, current);
}

/**
 * 形状校验（与 migration 的 CHECK 一一对应）。
 *
 * 返回归一化后的结果（把 undefined 统一成 null），方便直接 bind 给 D1。
 */
export function validateVersionShape(v: VersionInput): VersionInput {
  const out: VersionInput = { ...v };

  // ---- 周期与 cycle_days ----
  if (out.cycle_type === 'days') {
    if (out.cycle_days === null || out.cycle_days <= 0) {
      throw invalid("cycle_type = 'days' 时必须给出正整数 cycle_days");
    }
  } else if (out.cycle_days !== null) {
    throw invalid(`cycle_type = '${out.cycle_type}' 时不能出现 cycle_days`);
  }

  // ---- 试用 ----
  if (out.is_trial === 1) {
    if (out.trial_end_date === null) {
      throw invalid('is_trial = true 时必须给出 trial_end_date');
    }
    if (compareDateOnly(out.trial_end_date, out.effective_from) <= 0) {
      throw invalid('trial_end_date 必须晚于 effective_from');
    }
  } else {
    if (out.trial_end_date !== null) {
      throw invalid('非试用版本不能有 trial_end_date');
    }
    if (
      out.after_trial_amount_minor !== null ||
      out.after_trial_currency !== null ||
      out.after_trial_cycle_type !== null ||
      out.after_trial_cycle_days !== null
    ) {
      throw invalid('非试用版本不能有 after_trial_* 字段');
    }
  }

  // ---- 转正价格 ----
  const hasAfterAmount = out.after_trial_amount_minor !== null;
  const hasAfterCurrency = out.after_trial_currency !== null;
  if (hasAfterAmount !== hasAfterCurrency) {
    throw invalid('after_trial_amount_minor 与 after_trial_currency 必须成对出现');
  }

  if (out.after_trial_cycle_type === 'days') {
    if (out.after_trial_cycle_days === null || out.after_trial_cycle_days <= 0) {
      throw invalid("after_trial_cycle_type = 'days' 时必须给出正整数 after_trial_cycle_days");
    }
  } else if (out.after_trial_cycle_type === null) {
    if (out.after_trial_cycle_days !== null) {
      throw invalid('没有 after_trial_cycle_type 时不能出现 after_trial_cycle_days');
    }
  } else if (out.after_trial_cycle_days !== null) {
    throw invalid(`after_trial_cycle_type = '${out.after_trial_cycle_type}' 时不能出现 after_trial_cycle_days`);
  }

  return out;
}

/** 版本是否已经生效（生效后金额/币种/周期/生效日被触发器冻结）。 */
export function isEffective(version: Pick<SubscriptionVersionRow, 'effective_from'>, today: string): boolean {
  return compareDateOnly(version.effective_from, today) <= 0;
}

/** PATCH 版本时，除了 plan_name 之外出现的就是「冻结字段」。 */
export const VERSION_FROZEN_FIELDS = [
  'amount_minor',
  'currency',
  'cycle_type',
  'cycle_days',
  'effective_from',
  'is_trial',
  'trial_end_date',
  'after_trial_amount_minor',
  'after_trial_currency',
  'after_trial_cycle_type',
  'after_trial_cycle_days',
] as const;

/** 请求里是否包含任何冻结字段。 */
export function touchedFrozenFields(body: JsonObject): string[] {
  return VERSION_FROZEN_FIELDS.filter((f) => has(body, f));
}
