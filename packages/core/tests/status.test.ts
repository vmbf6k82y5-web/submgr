import { describe, expect, it } from 'vitest';
import {
  countByStatus,
  currentVersion,
  dueAnchorFor,
  firstVersion,
  getStatus,
  getStatusForAll,
  latestCharge,
  latestVersion,
  projectAfterTrialVersions,
  trialConversionDate,
  versionAt,
  versionsForSubscription,
} from '../src/status.js';
import { makeCharge, makeSubscription, makeVersion } from './fixtures.js';

const SUB = 'sub-0001';

function autoSub(overrides = {}) {
  return makeSubscription({ id: SUB, renew_mode: 'auto', start_date: '2024-01-15', ...overrides });
}

function manualSub(overrides = {}) {
  return makeSubscription({ id: SUB, renew_mode: 'manual', start_date: '2024-01-15', ...overrides });
}

function monthly(overrides = {}) {
  return makeVersion({ subscription_id: SUB, effective_from: '2024-01-15', ...overrides });
}

describe('status: 正常状态', () => {
  it('自动续费的健康订阅', () => {
    const r = getStatus(autoSub(), [monthly()], '2024-03-20');
    expect(r.status).toBe('active');
    expect(r.reasonCode).toBe('ok');
    expect(r.nextDueDate).toBe('2024-04-15');
    expect(r.currentVersionId).not.toBeNull();
  });

  it('还没开始的订阅算 active（scheduled），不是异常', () => {
    const sub = autoSub({ start_date: '2024-06-15' });
    const v = monthly({ effective_from: '2024-06-15' });
    const r = getStatus(sub, [v], '2024-01-01');
    expect(r.status).toBe('active');
    expect(r.reasonCode).toBe('scheduled');
    expect(r.nextDueDate).toBe('2024-06-15');
  });

  it('终身订阅永远是 active/lifetime，且没有下次到期日', () => {
    const sub = autoSub({ start_date: '2024-01-01' });
    const v = monthly({ effective_from: '2024-01-01', cycle_type: 'lifetime', amount_minor: 214800 });
    const r = getStatus(sub, [v], '2030-01-01');
    expect(r.status).toBe('active');
    expect(r.reasonCode).toBe('lifetime');
    expect(r.nextDueDate).toBeNull();
  });
});

describe('status: ended', () => {
  it('已取消', () => {
    const sub = autoSub({ cancelled_at: '2024-02-01T00:00:00.000Z' });
    const r = getStatus(sub, [monthly()], '2024-03-20');
    expect(r.status).toBe('ended');
    expect(r.reasonCode).toBe('cancelled');
    expect(r.nextDueDate).toBeNull();
  });

  it('过了结束日', () => {
    const sub = autoSub({ end_date: '2024-03-01' });
    const r = getStatus(sub, [monthly()], '2024-03-20');
    expect(r.status).toBe('ended');
    expect(r.reasonCode).toBe('end_date_passed');
    expect(r.reason).toContain('2024-03-01');
  });

  it('结束日当天还不算结束', () => {
    const sub = autoSub({ end_date: '2024-03-20' });
    const r = getStatus(sub, [monthly()], '2024-03-20');
    expect(r.status).toBe('active');
  });

  it('取消优先于一切异常（即使扣款失败）', () => {
    const sub = autoSub({ cancelled_at: '2024-02-01T00:00:00.000Z' });
    const charges = [makeCharge({ subscription_id: SUB, status: 'failed' })];
    const r = getStatus(sub, [monthly()], '2024-03-20', charges);
    expect(r.status).toBe('ended');
    expect(r.reasonCode).toBe('cancelled');
  });
});

describe('status: anomaly - 数据不完整', () => {
  it('一个版本都没有', () => {
    const r = getStatus(autoSub(), [], '2024-03-20');
    expect(r.status).toBe('anomaly');
    expect(r.reasonCode).toBe('no_version');
  });

  it('软删除的版本不算数', () => {
    const deleted = monthly({ deleted_at: '2024-02-01T00:00:00.000Z' });
    const r = getStatus(autoSub(), [deleted], '2024-03-20');
    expect(r.status).toBe('anomaly');
    expect(r.reasonCode).toBe('no_version');
  });

  it('其他订阅的版本不会被误用', () => {
    const other = monthly({ subscription_id: 'other-sub' });
    const r = getStatus(autoSub(), [other], '2024-03-20');
    expect(r.status).toBe('anomaly');
    expect(r.reasonCode).toBe('no_version');
  });
});

describe('status: anomaly - 试用', () => {
  const trialEnd = '2024-02-14';
  const trialVersion = () =>
    makeVersion({
      subscription_id: SUB,
      effective_from: '2024-01-15',
      amount_minor: 0,
      cycle_type: 'month',
      is_trial: 1,
      trial_end_date: trialEnd,
      after_trial_amount_minor: 9900,
      after_trial_currency: 'CNY',
      after_trial_cycle_type: 'month',
    });

  it('试用中', () => {
    const r = getStatus(autoSub(), [trialVersion()], '2024-02-01');
    expect(r.status).toBe('active');
    expect(r.reasonCode).toBe('trial_active');
    expect(r.reason).toContain(trialEnd);
  });

  it('试用最后一天仍然正常（Cron 当天还没跑也不算异常）', () => {
    const r = getStatus(autoSub(), [trialVersion()], trialEnd);
    expect(r.status).toBe('active');
    expect(r.reasonCode).toBe('trial_active');
  });

  it('试用过期却没有转正版本', () => {
    const r = getStatus(autoSub(), [trialVersion()], '2024-02-15');
    expect(r.status).toBe('anomaly');
    expect(r.reasonCode).toBe('trial_expired_no_conversion');
    expect(r.reason).toContain(trialEnd);
  });

  it('试用已经转正（Cron 插入了 effective_from = trial_end_date 的版本）', () => {
    const converted = makeVersion({
      subscription_id: SUB,
      effective_from: trialEnd,
      amount_minor: 9900,
      currency: 'CNY',
      cycle_type: 'month',
      is_trial: 0,
    });
    const r = getStatus(autoSub(), [trialVersion(), converted], '2024-02-15');
    expect(r.status).toBe('active');
    expect(r.reasonCode).toBe('ok');
    expect(r.currentVersionId).toBe(converted.id);
  });

  it('转正日当天取的是转正版本而不是试用版本', () => {
    const converted = makeVersion({
      subscription_id: SUB,
      effective_from: trialEnd,
      amount_minor: 9900,
      cycle_type: 'month',
      is_trial: 0,
    });
    const r = getStatus(autoSub(), [trialVersion(), converted], trialEnd);
    expect(r.currentVersionId).toBe(converted.id);
    expect(r.status).toBe('active');
  });
});

describe('status: anomaly - 最近一次扣款失败', () => {
  it('最近一次失败 -> 异常', () => {
    const charges = [
      makeCharge({ subscription_id: SUB, charge_date: '2024-02-15', status: 'paid' }),
      makeCharge({ subscription_id: SUB, charge_date: '2024-03-15', status: 'failed' }),
    ];
    const r = getStatus(autoSub(), [monthly()], '2024-03-20', charges);
    expect(r.status).toBe('anomaly');
    expect(r.reasonCode).toBe('last_charge_failed');
    expect(r.reason).toContain('2024-03-15');
  });

  it('失败之后又成功扣款 -> 恢复正常', () => {
    const charges = [
      makeCharge({ subscription_id: SUB, charge_date: '2024-03-15', status: 'failed' }),
      makeCharge({ subscription_id: SUB, charge_date: '2024-03-16', status: 'paid' }),
    ];
    const r = getStatus(autoSub(), [monthly()], '2024-03-20', charges);
    expect(r.status).toBe('active');
    expect(r.reasonCode).toBe('ok');
  });

  it('同一天内以 created_at 更晚的为准', () => {
    const charges = [
      makeCharge({
        subscription_id: SUB,
        charge_date: '2024-03-15',
        status: 'failed',
        created_at: '2024-03-15T10:00:00.000Z',
      }),
      makeCharge({
        subscription_id: SUB,
        charge_date: '2024-03-15',
        status: 'paid',
        created_at: '2024-03-15T12:00:00.000Z',
      }),
    ];
    expect(latestCharge(charges)?.status).toBe('paid');
    expect(getStatus(autoSub(), [monthly()], '2024-03-20', charges).status).toBe('active');
  });

  it('退款不算失败', () => {
    const charges = [makeCharge({ subscription_id: SUB, status: 'refunded' })];
    expect(getStatus(autoSub(), [monthly()], '2024-03-20', charges).status).toBe('active');
  });

  it('其他订阅的失败扣款不影响本订阅', () => {
    const charges = [makeCharge({ subscription_id: 'other', status: 'failed' })];
    expect(getStatus(autoSub(), [monthly()], '2024-03-20', charges).status).toBe('active');
  });

  it('软删除的失败扣款不影响', () => {
    const charges = [
      makeCharge({
        subscription_id: SUB,
        status: 'failed',
        deleted_at: '2024-03-16T00:00:00.000Z',
      }),
    ];
    expect(getStatus(autoSub(), [monthly()], '2024-03-20', charges).status).toBe('active');
  });
});

describe('status: anomaly - 手动续费过期未续', () => {
  it('过了到期日却没有续费记录 -> 标红', () => {
    const r = getStatus(manualSub(), [monthly()], '2024-03-20');
    expect(r.status).toBe('anomaly');
    expect(r.reasonCode).toBe('manual_renew_overdue');
    expect(r.reason).toContain('2024-03-15');
    expect(r.nextDueDate).toBe('2024-04-15');
  });

  it('到期日当天还不算逾期', () => {
    const r = getStatus(manualSub(), [monthly()], '2024-03-15');
    expect(r.status).toBe('active');
  });

  it('初始版本覆盖第一期，所以刚建好的订阅不会立刻标红', () => {
    const r = getStatus(manualSub(), [monthly()], '2024-01-20');
    expect(r.status).toBe('active');
    expect(r.reasonCode).toBe('ok');
  });

  it('第二期没续费就标红了', () => {
    const r = getStatus(manualSub(), [monthly()], '2024-02-20');
    expect(r.status).toBe('anomaly');
    expect(r.reasonCode).toBe('manual_renew_overdue');
    expect(r.reason).toContain('2024-02-15');
  });

  it('补一笔续费扣款就恢复正常', () => {
    const charges = [
      makeCharge({ subscription_id: SUB, charge_date: '2024-02-15', status: 'paid' }),
      makeCharge({ subscription_id: SUB, charge_date: '2024-03-15', status: 'paid' }),
    ];
    expect(getStatus(manualSub(), [monthly()], '2024-03-20', charges).status).toBe('active');
  });

  it('在到期日新建一个版本也算续费', () => {
    const v2 = makeVersion({
      subscription_id: SUB,
      effective_from: '2024-03-15',
      amount_minor: 3000,
    });
    const r = getStatus(manualSub(), [monthly(), v2], '2024-03-20');
    expect(r.status).toBe('active');
    expect(r.currentVersionId).toBe(v2.id);
  });

  it('只续到上一期时，本期仍然标红', () => {
    const charges = [makeCharge({ subscription_id: SUB, charge_date: '2024-02-15', status: 'paid' })];
    const r = getStatus(manualSub(), [monthly()], '2024-03-20', charges);
    expect(r.status).toBe('anomaly');
    expect(r.reasonCode).toBe('manual_renew_overdue');
  });

  it('未来的扣款记录不能算作已续费', () => {
    const charges = [makeCharge({ subscription_id: SUB, charge_date: '2024-03-25', status: 'paid' })];
    expect(getStatus(manualSub(), [monthly()], '2024-03-20', charges).status).toBe('anomaly');
  });

  it('自动续费的订阅不受此规则影响', () => {
    const r = getStatus(autoSub(), [monthly()], '2024-03-20');
    expect(r.status).toBe('active');
    expect(r.reasonCode).toBe('ok');
  });

  it('手动续费的终身订阅不会过期', () => {
    const sub = manualSub({ start_date: '2024-01-01' });
    const v = monthly({ effective_from: '2024-01-01', cycle_type: 'lifetime' });
    const r = getStatus(sub, [v], '2030-06-01');
    expect(r.status).toBe('active');
    expect(r.reasonCode).toBe('lifetime');
  });

  it('手动续费的固定天数订阅同样判过期', () => {
    const sub = manualSub({ start_date: '2024-01-01' });
    const v = monthly({ effective_from: '2024-01-01', cycle_type: 'days', cycle_days: 7 });
    // 2024-01-01 起每 7 天；2024-01-20 时上一次到期是 01-15
    const r = getStatus(sub, [v], '2024-01-20');
    expect(r.status).toBe('anomaly');
    expect(r.reasonCode).toBe('manual_renew_overdue');
    expect(r.reason).toContain('2024-01-15');
  });

  it('年付手动订阅跨年未续', () => {
    const sub = manualSub({ start_date: '2023-04-15' });
    const v = monthly({ effective_from: '2023-04-15', cycle_type: 'year' });
    expect(getStatus(sub, [v], '2024-03-01').status).toBe('active');
    expect(getStatus(sub, [v], '2024-04-16').status).toBe('anomaly');
  });
});

describe('status: 版本选取', () => {
  const v1 = makeVersion({ subscription_id: SUB, effective_from: '2024-01-15', amount_minor: 2500 });
  const v2 = makeVersion({ subscription_id: SUB, effective_from: '2024-03-15', amount_minor: 3000 });
  const versions = [v1, v2];

  it('当前版本 = effective_from <= today 里最新的一条', () => {
    expect(currentVersion(versions, '2024-01-14')).toBeNull();
    expect(currentVersion(versions, '2024-01-15')).toBe(v1);
    expect(currentVersion(versions, '2024-03-14')).toBe(v1);
    expect(currentVersion(versions, '2024-03-15')).toBe(v2); // 切换当天即生效
    expect(currentVersion(versions, '2024-03-16')).toBe(v2);
  });

  it('versionAt 用于按到期日挑版本', () => {
    expect(versionAt(versions, '2024-02-15')).toBe(v1);
    expect(versionAt(versions, '2024-04-15')).toBe(v2);
  });

  it('latestVersion / firstVersion', () => {
    expect(latestVersion(versions)).toBe(v2);
    expect(firstVersion(versions)).toBe(v1);
    expect(latestVersion([])).toBeNull();
    expect(firstVersion([])).toBeNull();
  });

  it('乱序输入也能正确排序', () => {
    expect(currentVersion([v2, v1], '2024-03-20')).toBe(v2);
    expect(versionsForSubscription([v2, v1], SUB).map((v) => v.id)).toEqual([v1.id, v2.id]);
  });

  it('软删除的版本被排除', () => {
    const deletedV2 = { ...v2, deleted_at: '2024-03-20T00:00:00.000Z' };
    expect(currentVersion([v1, deletedV2], '2024-03-20')).toBe(v1);
    // 价格切换前后
    expect(getStatus(autoSub(), [v1, v2], '2024-03-14').currentVersionId).toBe(v1.id);
    expect(getStatus(autoSub(), [v1, v2], '2024-03-15').currentVersionId).toBe(v2.id);
  });
});

describe('status: 批量与计数', () => {
  const subs = [
    makeSubscription({ id: 'a', start_date: '2024-01-15' }),
    makeSubscription({ id: 'b', start_date: '2024-01-15', cancelled_at: '2024-02-01T00:00:00.000Z' }),
    makeSubscription({ id: 'c', start_date: '2024-01-15' }),
    makeSubscription({ id: 'd', start_date: '2024-01-15', deleted_at: '2024-02-01T00:00:00.000Z' }),
  ];
  const versions = [
    makeVersion({ subscription_id: 'a', effective_from: '2024-01-15' }),
    makeVersion({ subscription_id: 'b', effective_from: '2024-01-15' }),
    // c 没有版本 -> anomaly
  ];

  it('过滤软删除的订阅', () => {
    const entries = getStatusForAll(subs, versions, '2024-03-20');
    expect(entries.map((e) => e.subscription.id)).toEqual(['a', 'b', 'c']);
  });

  it('按状态计数', () => {
    const counts = countByStatus(getStatusForAll(subs, versions, '2024-03-20'));
    expect(counts).toEqual({ active: 1, ended: 1, anomaly: 1 });
  });
});

describe('status: 试用转正投影', () => {
  it('没有转正版本时凭空造一个（只存在于内存）', () => {
    const trial = makeVersion({
      subscription_id: SUB,
      effective_from: '2024-01-15',
      amount_minor: 0,
      cycle_type: 'month',
      is_trial: 1,
      trial_end_date: '2024-02-14',
      after_trial_amount_minor: 9900,
      after_trial_currency: 'CNY',
      after_trial_cycle_type: 'month',
    });
    const projected = projectAfterTrialVersions([trial]);
    expect(projected).toHaveLength(2);
    expect(projected[1]!.effective_from).toBe('2024-02-14');
    expect(projected[1]!.amount_minor).toBe(9900);
    expect(projected[1]!.id).toContain('::after-trial');
    expect(projected[1]!.is_trial).toBe(0);
    // 当前版本在转正日之前仍是试用版本
    expect(currentVersion(projected, '2024-02-13')!.id).toBe(trial.id);
    // 转正日当天及以后是投影版本
    expect(currentVersion(projected, '2024-02-14')!.amount_minor).toBe(9900);
  });

  it('已经存在真实转正版本时不重复造', () => {
    const trial = makeVersion({
      subscription_id: SUB,
      effective_from: '2024-01-15',
      is_trial: 1,
      trial_end_date: '2024-02-14',
      after_trial_amount_minor: 9900,
      after_trial_currency: 'CNY',
      after_trial_cycle_type: 'month',
    });
    const real = makeVersion({
      subscription_id: SUB,
      effective_from: '2024-02-14',
      amount_minor: 9900,
    });
    expect(projectAfterTrialVersions([trial, real])).toHaveLength(2);
  });

  it('没填转正价格时不做投影', () => {
    const trial = makeVersion({
      subscription_id: SUB,
      effective_from: '2024-01-15',
      is_trial: 1,
      trial_end_date: '2024-02-14',
    });
    expect(projectAfterTrialVersions([trial])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// B1 定稿：试用转正后锚点 = 转正日（effective_from），转正后重新起算
// ---------------------------------------------------------------------------

/** 试用 1/1–1/14，转正后 ¥99.00/月。 */
function trialSub(overrides = {}) {
  return makeSubscription({
    id: 's-trial',
    name: 'Notion Plus',
    start_date: '2024-01-01',
    renew_mode: 'auto',
    ...overrides,
  });
}

function trialVersion(overrides = {}) {
  return makeVersion({
    id: 'v-trial',
    subscription_id: 's-trial',
    effective_from: '2024-01-01',
    amount_minor: 0,
    currency: 'CNY',
    cycle_type: 'month',
    is_trial: 1,
    trial_end_date: '2024-01-14',
    after_trial_amount_minor: 9900,
    after_trial_currency: 'CNY',
    after_trial_cycle_type: 'month',
    ...overrides,
  });
}

/** Cron 真实插入的转正版本。 */
function convertedVersion(overrides = {}) {
  return makeVersion({
    id: 'v-converted',
    subscription_id: 's-trial',
    effective_from: '2024-01-14',
    amount_minor: 9900,
    currency: 'CNY',
    cycle_type: 'month',
    is_trial: 0,
    ...overrides,
  });
}

describe('B1: 试用转正后的锚点', () => {
  it('trialConversionDate：认得出真实插入的转正版本', () => {
    expect(trialConversionDate([trialVersion(), convertedVersion()])).toBe('2024-01-14');
  });

  it('trialConversionDate：也认得出内存里的转正投影', () => {
    const projected = projectAfterTrialVersions([trialVersion()]);
    expect(trialConversionDate(projected)).toBe('2024-01-14');
  });

  it('trialConversionDate：没有试用、或试用没写转正价时都是 null', () => {
    expect(trialConversionDate([monthly()])).toBeNull();
    // 试用结束了但没填 after_trial_*，就没有转正这回事
    const bare = trialVersion({
      after_trial_amount_minor: null,
      after_trial_currency: null,
      after_trial_cycle_type: null,
    });
    expect(trialConversionDate([bare])).toBeNull();
    expect(trialConversionDate(projectAfterTrialVersions([bare]))).toBeNull();
  });

  it('dueAnchorFor：普通订阅仍用 start_date（行为不变）', () => {
    const sub = autoSub();
    expect(dueAnchorFor(sub, [monthly()])).toBe('2024-01-15');
  });

  it('dueAnchorFor：转过正的订阅用转正日，而不是 start_date', () => {
    const sub = trialSub();
    expect(dueAnchorFor(sub, [trialVersion(), convertedVersion()])).toBe('2024-01-14');
    // 转正版本还没落库时，靠投影也能得到同样的锚点
    expect(dueAnchorFor(sub, projectAfterTrialVersions([trialVersion()]))).toBe('2024-01-14');
  });

  it('转正后到期日从转正日起算：1/14 转正 -> 2/14，而不是 2/1', () => {
    const r = getStatus(trialSub(), [trialVersion(), convertedVersion()], '2024-01-20');
    expect(r.reasonCode).toBe('ok');
    expect(r.nextDueDate).toBe('2024-02-14');
    expect(r.nextDueDate).not.toBe('2024-02-01');
  });

  it('转正后遇到调价版本，锚点依然是转正日，不会跟着版本漂移', () => {
    const raised = convertedVersion({
      id: 'v-raised',
      effective_from: '2024-04-20',
      amount_minor: 12000,
    });
    const versions = [trialVersion(), convertedVersion(), raised];
    // 当前版本是 4/20 生效的调价版本，但周期仍锚在 1/14 -> 5/14
    const r = getStatus(trialSub(), versions, '2024-05-01');
    expect(r.currentVersionId).toBe('v-raised');
    expect(r.nextDueDate).toBe('2024-05-14');
  });

  it('试用进行中：下次到期日 = 转正日（不是试用版本自己那个无意义的周期日）', () => {
    const r = getStatus(trialSub(), [trialVersion()], '2024-01-05');
    expect(r.reasonCode).toBe('trial_active');
    expect(r.nextDueDate).toBe('2024-01-14');
  });

  it('试用过期但转正版本还没落库：下次到期日按转正日推算', () => {
    const r = getStatus(trialSub(), [trialVersion()], '2024-01-20');
    expect(r.reasonCode).toBe('trial_expired_no_conversion');
    expect(r.nextDueDate).toBe('2024-02-14');
  });

  it('转正后的年付周期也从转正日起算', () => {
    const v = trialVersion({ after_trial_cycle_type: 'year', after_trial_amount_minor: 99000 });
    const c = convertedVersion({ cycle_type: 'year', amount_minor: 99000 });
    const r = getStatus(trialSub(), [v, c], '2024-06-01');
    expect(r.nextDueDate).toBe('2025-01-14');
  });

  it('手动续费的「上一期到期日」也用转正后的锚点', () => {
    const sub = trialSub({ renew_mode: 'manual' });
    // 1/14 转正，月付 -> 上一期到期日应为 4/14（而不是 4/1）
    const r = getStatus(sub, [trialVersion(), convertedVersion()], '2024-04-20');
    expect(r.reasonCode).toBe('manual_renew_overdue');
    expect(r.reason).toContain('2024-04-14');
  });

  it('没写过转正价的试用：锚点退回 start_date，不凭空造周期', () => {
    const bare = trialVersion({
      after_trial_amount_minor: null,
      after_trial_currency: null,
      after_trial_cycle_type: null,
    });
    expect(dueAnchorFor(trialSub(), [bare])).toBe('2024-01-01');
  });
});
