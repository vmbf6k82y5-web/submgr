/**
 * 价格版本相关的纯逻辑（可单测）。
 *
 * 需求硬性要求：**改价格必须引导用户新建版本，而不是直接修改已生效版本**。
 * 判断「这次改动算不算改价」以及「为什么不能直接改」的规则都在这里，
 * 页面只负责展示，避免把业务判断散在 JSX 里。
 */

import { cycleTypeLabel, type CycleType, type SubscriptionVersionRow } from '@submgr/core';
import { inputToMinor, minorToInput } from './format';
import type { VersionInput } from './types';

export interface PriceDraft {
  amountMinor: number | null;
  currency: string;
  cycleType: CycleType;
  cycleDays: number | null;
}

/** 版本是否已生效（= 已冻结）：生效日 <= 今天。 */
export function isFrozen(version: Pick<SubscriptionVersionRow, 'effective_from'>, today: string): boolean {
  return version.effective_from <= today;
}

/** 返回「被改动的冻结字段」的中文名；空数组表示没改价格相关字段。 */
export function changedFrozenFields(
  current: PriceDraft | null,
  next: PriceDraft,
): string[] {
  if (current === null) return [];
  const changed: string[] = [];
  if (current.amountMinor !== next.amountMinor) changed.push('金额');
  if (current.currency !== next.currency) changed.push('币种');
  if (current.cycleType !== next.cycleType) changed.push('周期');
  if (current.cycleType === 'days' && next.cycleType === 'days' && current.cycleDays !== next.cycleDays) {
    changed.push('周期天数');
  }
  return changed;
}

export interface NewVersionHint {
  /** 是否必须走「新建版本」 */
  needsNewVersion: boolean;
  /** 直接展示给用户的中文说明 */
  message: string;
  /** 变更点，用于列表展示 */
  changed: string[];
}

/**
 * 给编辑页用的判断：
 *   * 已生效版本被改了金额/币种/周期 → 必须新建版本；
 *   * 没改 → 不需要新建，保存按钮就不该出现；
 *   * 还没有任何生效版本（例如全是未来版本）→ 提示可以改现有版本。
 */
export function newVersionHint(
  current: SubscriptionVersionRow | null,
  draft: PriceDraft,
  today: string,
): NewVersionHint {
  if (!current) {
    return {
      needsNewVersion: false,
      message: '这个订阅还没有生效中的价格版本，直接新建一个即可。',
      changed: [],
    };
  }

  const changed = changedFrozenFields(priceDraftOf(current), draft);
  if (!isFrozen(current, today)) {
    return {
      needsNewVersion: false,
      message: `当前版本 ${current.effective_from} 还没生效，可以直接修改它，不必新建版本。`,
      changed,
    };
  }

  if (changed.length === 0) {
    return {
      needsNewVersion: false,
      message: '金额、币种、周期都没变，不需要新建版本。',
      changed,
    };
  }

  return {
    needsNewVersion: true,
    message:
      `检测到改动了${changed.join('、')}。版本 ${current.effective_from} 已经生效并冻结，` +
      '不能直接改（历史扣款按当时的版本记账）。保存后会新增一个价格版本，' +
      `从新版本的生效日起按新价格计算，${current.effective_from} 之前的历史不受影响。`,
    changed,
  };
}

export function priceDraftOf(version: SubscriptionVersionRow): PriceDraft {
  return {
    amountMinor: version.amount_minor,
    currency: version.currency,
    cycleType: version.cycle_type,
    cycleDays: version.cycle_days,
  };
}

/** 同一个订阅同一天只能有一个版本，表单里先拦一道，省得白跑一次 409。 */
export function hasVersionOn(
  versions: readonly SubscriptionVersionRow[],
  effectiveFrom: string,
  ignoreVersionId?: string,
): boolean {
  return versions.some(
    (version) =>
      version.effective_from === effectiveFrom &&
      version.id !== ignoreVersionId &&
      !version.deleted_at,
  );
}

/** 「周期」的中文描述，例如「月付」「固定天数（30 天）」。 */
export function describeCycle(cycleType: CycleType, cycleDays: number | null): string {
  if (cycleType === 'days') return `固定天数（${cycleDays ?? '?'} 天）`;
  return cycleTypeLabel(cycleType);
}

// ---------------------------------------------------------------------------
// 表单草稿 -> 接口请求体（校验也在这里，页面只管展示错误）
// ---------------------------------------------------------------------------

export const CYCLE_OPTIONS: { value: CycleType; label: string }[] = [
  { value: 'month', label: '月付' },
  { value: 'quarter', label: '季付' },
  { value: 'half_year', label: '半年付' },
  { value: 'year', label: '年付' },
  { value: 'days', label: '固定天数' },
  { value: 'lifetime', label: '终身（一次性）' },
];

/** 常用币种（ISO 4217；大小写不敏感，接口要求 3 位大写字母）。 */
export const COMMON_CURRENCIES = ['CNY', 'USD', 'HKD', 'JPY', 'EUR', 'GBP', 'KRW', 'SGD', 'TWD', 'AUD', 'CAD'];

export interface VersionDraft {
  effectiveFrom: string;
  planName: string;
  amount: string;
  currency: string;
  cycleType: CycleType;
  cycleDays: string;
  isTrial: boolean;
  trialEndDate: string;
  afterTrialAmount: string;
  afterTrialCycleType: CycleType | '';
}

export function emptyVersionDraft(currency: string, effectiveFrom: string): VersionDraft {
  return {
    effectiveFrom,
    planName: '',
    amount: '',
    currency,
    cycleType: 'month',
    cycleDays: '',
    isTrial: false,
    trialEndDate: '',
    afterTrialAmount: '',
    afterTrialCycleType: '',
  };
}

export function draftFromVersion(version: SubscriptionVersionRow): VersionDraft {
  return {
    effectiveFrom: version.effective_from,
    planName: version.plan_name ?? '',
    amount: minorToInput(version.amount_minor, version.currency),
    currency: version.currency,
    cycleType: version.cycle_type,
    cycleDays: version.cycle_days === null ? '' : String(version.cycle_days),
    isTrial: version.is_trial === 1 || version.is_trial === true,
    trialEndDate: version.trial_end_date ?? '',
    afterTrialAmount:
      version.after_trial_amount_minor === null
        ? ''
        : minorToInput(version.after_trial_amount_minor, version.after_trial_currency ?? version.currency),
    afterTrialCycleType: version.after_trial_cycle_type ?? '',
  };
}

export type DraftValidation =
  | { ok: true; value: VersionInput }
  | { ok: false; error: string; field?: keyof VersionDraft };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 校验并转换价格草稿。
 *
 * 注意金额输入是「主单位字符串」（例如 25.00），这里才换成整数最小单位；
 * 精度超出币种小数位会直接报错（core 的 fromMajorString 抛的错），不静默截断。
 */
export function validateVersionDraft(draft: VersionDraft): DraftValidation {
  if (!DATE_RE.test(draft.effectiveFrom)) {
    return { ok: false, error: '生效日必须是 YYYY-MM-DD', field: 'effectiveFrom' };
  }

  const currency = draft.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, error: '币种必须是 3 位字母（ISO 4217，例如 CNY）', field: 'currency' };
  }

  const amount = inputToMinor(draft.amount, currency);
  if (!amount.ok) return { ok: false, error: amount.error, field: 'amount' };

  let cycleDays: number | null = null;
  if (draft.cycleType === 'days') {
    const parsed = Number(draft.cycleDays);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { ok: false, error: '固定天数周期必须给出正整数天数', field: 'cycleDays' };
    }
    cycleDays = parsed;
  }

  let trialEndDate: string | null = null;
  let afterTrialAmountMinor: number | null = null;
  let afterTrialCurrency: string | null = null;
  let afterTrialCycleType: CycleType | null = null;
  let afterTrialCycleDays: number | null = null;

  if (draft.isTrial) {
    if (!DATE_RE.test(draft.trialEndDate)) {
      return { ok: false, error: '试用必须给出试用结束日（YYYY-MM-DD）', field: 'trialEndDate' };
    }
    if (draft.trialEndDate <= draft.effectiveFrom) {
      return { ok: false, error: '试用结束日必须晚于生效日', field: 'trialEndDate' };
    }
    trialEndDate = draft.trialEndDate;

    if (draft.afterTrialAmount.trim() !== '') {
      const afterAmount = inputToMinor(draft.afterTrialAmount, currency);
      if (!afterAmount.ok) {
        return { ok: false, error: `转正价：${afterAmount.error}`, field: 'afterTrialAmount' };
      }
      if (draft.afterTrialCycleType === '') {
        return { ok: false, error: '填了转正价就必须选转正后的周期', field: 'afterTrialCycleType' };
      }
      afterTrialAmountMinor = afterAmount.value;
      afterTrialCurrency = currency;
      afterTrialCycleType = draft.afterTrialCycleType;
      afterTrialCycleDays = draft.afterTrialCycleType === 'days' ? (cycleDays ?? null) : null;
    }
  }

  return {
    ok: true,
    value: {
      effective_from: draft.effectiveFrom,
      plan_name: draft.planName.trim() === '' ? null : draft.planName.trim(),
      amount_minor: amount.value,
      currency,
      cycle_type: draft.cycleType,
      cycle_days: cycleDays,
      is_trial: draft.isTrial,
      trial_end_date: trialEndDate,
      after_trial_amount_minor: afterTrialAmountMinor,
      after_trial_currency: afterTrialCurrency,
      after_trial_cycle_type: afterTrialCycleType,
      after_trial_cycle_days: afterTrialCycleDays,
    },
  };
}

