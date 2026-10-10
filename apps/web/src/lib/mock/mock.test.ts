import { beforeEach, describe, expect, it } from 'vitest';
import { addMonthsToMonthKey } from '@submgr/core';
import { ApiError } from '../apiError';
import { buildMockState, getMockState, resetMockState } from './data';
import { mockRequest } from './handler';
import { listResponse, mockToday, summaryResponse, trendsResponse } from './dto';

beforeEach(() => {
  resetMockState();
});

describe('mock: 数据集完整性', () => {
  it('相对今天生成，七个订阅都有价格版本', () => {
    const state = buildMockState('healthy', new Date('2026-10-10T02:00:00.000Z'));
    expect(state.settings.timezone).toBe('Asia/Shanghai');
    expect(state.subscriptions).toHaveLength(7);
    for (const sub of state.subscriptions) {
      expect(state.versions.some((v) => v.subscription_id === sub.id)).toBe(true);
    }
  });

  it('三种状态各有样本（正常 / 异常 / 已结束）', () => {
    const state = buildMockState('healthy', new Date('2026-10-10T02:00:00.000Z'));
    const list = listResponse(state, {});
    expect(list.counts.total).toBe(7);
    expect(list.counts.active).toBe(5);
    expect(list.counts.anomaly).toBe(1);
    expect(list.counts.ended).toBe(1);
    expect(list.items.find((i) => i.status === 'anomaly')?.name).toBe('Notion Plus');
  });

  it('有外币扣款（Netflix）与涨价历史（爱奇艺两个版本）', () => {
    const state = buildMockState('healthy', new Date('2026-10-10T02:00:00.000Z'));
    const netflix = state.charges.filter((c) => c.subscription_id === 'sub-netflix');
    expect(netflix.length).toBeGreaterThanOrEqual(5);
    expect(netflix.every((c) => c.currency === 'USD' && c.base_amount_minor !== null)).toBe(true);
    // 每期冻结的汇率都不同（历史金额不跟着最新汇率变）
    const rates = new Set(netflix.map((c) => c.fx_rate_to_base));
    expect(rates.size).toBeGreaterThan(1);

    const iqiyiVersions = state.versions.filter((v) => v.subscription_id === 'sub-iqiyi');
    expect(iqiyiVersions).toHaveLength(2);
    expect(iqiyiVersions[0]?.amount_minor).toBe(2500);
    expect(iqiyiVersions[1]?.amount_minor).toBe(3000);
    // 涨价前的扣款按旧价、涨价后按新价
    const iqiyiCharges = state.charges
      .filter((c) => c.subscription_id === 'sub-iqiyi')
      .sort((a, b) => (a.charge_date < b.charge_date ? -1 : 1));
    const first = iqiyiCharges[0];
    const last = iqiyiCharges[iqiyiCharges.length - 1];
    expect(first?.amount_minor).toBe(2500);
    expect(last?.amount_minor).toBe(3000);
  });
});

describe('mock: 汇总（与 Worker 同一套 core 口径）', () => {
  const NOW = '2026-10-10T02:00:00.000Z';

  it('健康场景：三个合计都有数字，汇率不过期', () => {
    const state = buildMockState('healthy', new Date(NOW));
    const summary = summaryResponse(state, 30);
    expect(summary.baseCurrency).toBe('CNY');
    expect(summary.monthlyAverageMinor).not.toBeNull();
    expect(summary.yearlyAverageMinor).not.toBeNull();
    expect(summary.next30DaysMinor).not.toBeNull();
    expect(summary.stale).toBe(false);
    expect(summary.missingCurrencies).toEqual([]);
    expect(summary.counts).toEqual({ total: 7, active: 5, ended: 1, anomaly: 1 });
    expect(summary.anomalies).toHaveLength(1);
    expect(summary.byStatus.ended).toHaveLength(1);
  });

  it('stale 场景：汇率过期 72 小时', () => {
    const state = buildMockState('stale', new Date(NOW));
    const summary = summaryResponse(state, 30);
    expect(summary.stale).toBe(true);
    expect(summary.fxAgeHours).toBeGreaterThan(48);
    expect(summary.missingCurrencies).toEqual([]);
  });

  it('missing 场景：缺 JPY -> 合计为 null（而不是少算 Nintendo）', () => {
    const state = buildMockState('missing', new Date(NOW));
    const summary = summaryResponse(state, 30);
    expect(summary.missingCurrencies).toContain('JPY');
    expect(summary.monthlyAverageMinor).toBeNull();
    expect(summary.yearlyAverageMinor).toBeNull();
  });

  it('趋势：12 个月连续、四维度都能分组', () => {
    const state = buildMockState('healthy', new Date(NOW));
    for (const dimension of ['category', 'cycle', 'channel', 'type'] as const) {
      const trend = trendsResponse(state, dimension);
      expect(trend.item.dimension).toBe(dimension);
      expect(trend.item.months).toHaveLength(12);
      expect(trend.item.groups.length).toBeGreaterThan(0);
      expect(trend.item.grandTotalMinor).not.toBeNull();
      // 每个月都有数据点（缺汇率时是 null，但不能缺格子）
      for (const month of trend.item.months) {
        expect(trend.item.cells.some((cell) => cell.month === month)).toBe(true);
      }
    }
  });

  it('missing 场景：缺汇率的格子留空（null）并列出缺失币种，不使用 0', () => {
    const state = buildMockState('missing', new Date(NOW));
    const trend = trendsResponse(state, 'channel');
    expect(trend.item.months).toHaveLength(12);
    expect(trend.item.missingCurrencies).toContain('JPY');
    const nullCells = trend.item.cells.filter((cell) => cell.amountBaseMinor === null);
    expect(nullCells.length).toBeGreaterThan(0);
    expect(trend.item.grandTotalMinor).toBeNull();
    // 同一天的总览同样算不出来（两个接口口径一致）
    expect(summaryResponse(state, 30).monthlyAverageMinor).toBeNull();
  });

  it('healthy 场景：日元有汇率时能正常折算，不留空格子', () => {
    const state = buildMockState('healthy', new Date(NOW));
    const trend = trendsResponse(state, 'channel');
    expect(trend.item.missingCurrencies).toEqual([]);
    expect(trend.item.cells.every((cell) => cell.amountBaseMinor !== null)).toBe(true);
  });
});

describe('mock: 写入（示例数据模式下页面可点）', () => {
  const scenario = 'healthy' as const;
  const scenarioState = () => getMockState(scenario);
  // 用一个「肯定没有版本占用」的日期：上个月 20 号
  const unusedDay = (): string => `${addMonthsToMonthKey(mockToday(scenarioState()).slice(0, 7), -1)}-20`;

  it('新建订阅（顺带首个版本）', () => {
    const today = mockToday(scenarioState());
    const before = scenarioState().subscriptions.length;
    const created = mockRequest<{ item: { id: string; name: string }; created_version_id: string }>(
      'POST',
      '/api/subscriptions',
      {
        scenario,
        body: {
          name: '测试订阅',
          sub_type: 'software',
          charge_channel: 'alipay',
          renew_mode: 'auto',
          start_date: today,
          version: {
            effective_from: today,
            amount_minor: 1000,
            currency: 'CNY',
            cycle_type: 'month',
          },
        },
      },
    );
    expect(created.item.name).toBe('测试订阅');
    expect(created.created_version_id).toBeTruthy();
    expect(scenarioState().subscriptions).toHaveLength(before + 1);
  });

  it('新增价格版本：同一天重复会被 409 拦下', () => {
    const state = scenarioState();
    const target = state.subscriptions[0];
    expect(target).toBeDefined();
    const id = target?.id ?? '';
    const date = unusedDay();

    const created = mockRequest<{ item: { id: string } }>('POST', `/api/subscriptions/${id}/versions`, {
      scenario,
      body: {
        effective_from: date,
        amount_minor: 3200,
        currency: 'CNY',
        cycle_type: 'month',
      },
    });
    expect(created.item.id).toBeTruthy();

    expect(() =>
      mockRequest('POST', `/api/subscriptions/${id}/versions`, {
        scenario,
        body: {
          effective_from: date,
          amount_minor: 3300,
          currency: 'CNY',
          cycle_type: 'month',
        },
      }),
    ).toThrowError(/已经有一个版本/);
  });

  it('手动记账：外币按冻结汇率折算基准金额', () => {
    const response = mockRequest<{ item: { base_amount_minor: number | null; fx_rate_to_base: string | null } }>(
      'POST',
      '/api/charges',
      {
        scenario,
        body: {
          subscription_id: 'sub-netflix',
          charge_date: mockToday(scenarioState()),
          amount_minor: 2299,
          currency: 'USD',
          status: 'paid',
        },
      },
    );
    expect(response.item.fx_rate_to_base).not.toBeNull();
    expect(response.item.base_amount_minor).toBeGreaterThan(0);
  });

  it('缺汇率的币种记账时基准金额留空并给出警告', () => {
    const response = mockRequest<{ item: { base_amount_minor: number | null }; fx_warning: string | null }>(
      'POST',
      '/api/charges',
      {
        scenario: 'missing',
        body: {
          subscription_id: 'sub-nintendo',
          charge_date: mockToday(getMockState('missing')),
          amount_minor: 4500,
          currency: 'JPY',
          status: 'paid',
        },
      },
    );
    expect(response.item.base_amount_minor).toBeNull();
    expect(response.fx_warning).toContain('缺少 JPY');
  });

  it('设置：改基准币种与重置 ICS 令牌', () => {
    const updated = mockRequest<{ item: { base_currency: string } }>('PUT', '/api/settings', {
      scenario,
      body: { base_currency: 'USD', amortize_lifetime_months: 24 },
    });
    expect(updated.item.base_currency).toBe('USD');

    const before = scenarioState().settings.ics_token;
    const rotated = mockRequest<{ item: { ics_token: string; ics_path: string } }>(
      'POST',
      '/api/settings/reset-ics-token',
      { scenario },
    );
    expect(rotated.item.ics_token).not.toBe(before);
    expect(rotated.item.ics_path).toBe(`/ics/${rotated.item.ics_token}.ics`);
  });

  it('提醒渠道：新增校验密钥来源，删除是软删除', () => {
    expect(() =>
      mockRequest('POST', '/api/channels', {
        scenario,
        body: { type: 'feishu', name: '没有密钥' },
      }),
    ).toThrowError(/secret_ref 或 secrets_encrypted/);

    const created = mockRequest<{ item: { id: string; has_secrets_encrypted: boolean } }>(
      'POST',
      '/api/channels',
      {
        scenario,
        body: { type: 'feishu', name: '新渠道', secret_ref: 'FEISHU_NEW', config_json: { a: 1 } },
      },
    );
    expect(created.item.has_secrets_encrypted).toBe(false);

    const before = mockRequest<{ items: unknown[] }>('GET', '/api/channels', { scenario });
    mockRequest('DELETE', `/api/channels/${created.item.id}`, { scenario });
    const after = mockRequest<{ items: unknown[] }>('GET', '/api/channels', { scenario });
    expect(after.items).toHaveLength(before.items.length - 1);
  });

  it('未实现的接口明确报 404，而不是假装成功', () => {
    try {
      mockRequest('GET', '/api/reminders', { scenario });
      throw new Error('不应该走到这里');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(404);
      expect((error as ApiError).code).toBe('mock_not_implemented');
    }
  });

  it('筛选参数生效（状态 / 关键字 / 分类）', () => {
    const state = scenarioState();
    expect(listResponse(state, { status: 'anomaly' }).items).toHaveLength(1);
    expect(listResponse(state, { q: 'netflix' }).items).toHaveLength(1);
    expect(listResponse(state, { categoryId: 'cat-media' }).items).toHaveLength(3);
  });
});
