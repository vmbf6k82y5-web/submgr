import { describe, expect, it } from 'vitest';
import {
  cycleMonths,
  cyclesPerYear,
  dueDatesBetween,
  dueIndexOnOrAfter,
  nextDueDate,
  nthDueDate,
  previousDueDate,
  requireCycleDays,
} from '../src/cycles.js';
import type { CycleSpec } from '../src/types.js';

const monthly: CycleSpec = { cycle_type: 'month' };
const quarterly: CycleSpec = { cycle_type: 'quarter' };
const halfYearly: CycleSpec = { cycle_type: 'half_year' };
const yearly: CycleSpec = { cycle_type: 'year' };
const lifetime: CycleSpec = { cycle_type: 'lifetime' };
const every = (days: number): CycleSpec => ({ cycle_type: 'days', cycle_days: days });

describe('cycles: 周期月数', () => {
  it('month/quarter/half_year/year 的月数', () => {
    expect(cycleMonths('month')).toBe(1);
    expect(cycleMonths('quarter')).toBe(3);
    expect(cycleMonths('half_year')).toBe(6);
    expect(cycleMonths('year')).toBe(12);
  });

  it('days / lifetime 没有固定月数', () => {
    expect(cycleMonths('days')).toBeNull();
    expect(cycleMonths('lifetime')).toBeNull();
  });

  it('cycle_days 缺失时抛错，而不是当成 0 或 30', () => {
    expect(() => requireCycleDays({ cycle_type: 'days' })).toThrow(RangeError);
    expect(() => requireCycleDays({ cycle_type: 'days', cycle_days: 0 })).toThrow(RangeError);
    expect(() => requireCycleDays({ cycle_type: 'days', cycle_days: -5 })).toThrow(RangeError);
    expect(requireCycleDays({ cycle_type: 'days', cycle_days: 30 })).toBe(30);
  });

  it('每年期数', () => {
    expect(cyclesPerYear(monthly)).toBe(12);
    expect(cyclesPerYear(quarterly)).toBe(4);
    expect(cyclesPerYear(halfYearly)).toBe(2);
    expect(cyclesPerYear(yearly)).toBe(1);
    expect(cyclesPerYear(every(30))).toBeCloseTo(365 / 30, 10);
    expect(cyclesPerYear(lifetime)).toBeNull();
  });
});

describe('cycles: 月末锚点（需求原文的 1 月 31 日例子）', () => {
  it('1 月 31 日开始的月订阅：2 月落在月末，3 月回到 31 日', () => {
    const due = (i: number) => nthDueDate(monthly, '2024-01-31', i);

    expect(due(0)).toBe('2024-01-31');
    expect(due(1)).toBe('2024-02-29'); // 闰年 2 月
    expect(due(2)).toBe('2024-03-31'); // 关键：回到锚点 31，而不是停在 29
    expect(due(3)).toBe('2024-04-30');
    expect(due(4)).toBe('2024-05-31'); // 再次回到 31
    expect(due(5)).toBe('2024-06-30');
    expect(due(12)).toBe('2025-01-31'); // 跨年，锚点依然保持
  });

  it('平年同样回到锚点', () => {
    const due = (i: number) => nthDueDate(monthly, '2023-01-31', i);
    expect(due(1)).toBe('2023-02-28');
    expect(due(2)).toBe('2023-03-31');
    expect(due(13)).toBe('2024-02-29'); // 下一年正好是闰年
  });

  it('锚点在 30 日的订阅', () => {
    const due = (i: number) => nthDueDate(monthly, '2024-01-30', i);
    expect(due(1)).toBe('2024-02-29');
    expect(due(2)).toBe('2024-03-30');
    expect(due(3)).toBe('2024-04-30');
    expect(due(4)).toBe('2024-05-30');
  });

  it('3 月 31 日开始的月订阅', () => {
    const due = (i: number) => nthDueDate(monthly, '2024-03-31', i);
    expect(due(1)).toBe('2024-04-30');
    expect(due(2)).toBe('2024-05-31');
    expect(due(3)).toBe('2024-06-30');
  });

  it('季度 / 半年的锚点同样保持', () => {
    expect(nthDueDate(quarterly, '2024-08-31', 1)).toBe('2024-11-30');
    expect(nthDueDate(quarterly, '2024-08-31', 2)).toBe('2025-02-28');
    expect(nthDueDate(quarterly, '2024-08-31', 3)).toBe('2025-05-31');
    expect(nthDueDate(quarterly, '2024-08-31', 4)).toBe('2025-08-31');

    expect(nthDueDate(halfYearly, '2024-08-31', 1)).toBe('2025-02-28');
    expect(nthDueDate(halfYearly, '2024-08-31', 2)).toBe('2025-08-31');
  });
});

describe('cycles: 闰年', () => {
  it('2 月 29 日开始的年订阅，平年落到 2 月 28 日', () => {
    const due = (i: number) => nthDueDate(yearly, '2024-02-29', i);
    expect(due(0)).toBe('2024-02-29');
    expect(due(1)).toBe('2025-02-28'); // 平年
    expect(due(2)).toBe('2026-02-28');
    expect(due(3)).toBe('2027-02-28');
    expect(due(4)).toBe('2028-02-29'); // 又是闰年，回到 29
    expect(due(8)).toBe('2032-02-29');
  });

  it('2020-02-29 开始的年订阅', () => {
    expect(nthDueDate(yearly, '2020-02-29', 1)).toBe('2021-02-28');
    expect(nthDueDate(yearly, '2020-02-29', 4)).toBe('2024-02-29');
  });

  it('闰日的月订阅', () => {
    const due = (i: number) => nthDueDate(monthly, '2024-01-29', i);
    expect(due(1)).toBe('2024-02-29');
    expect(due(2)).toBe('2024-03-29');
    expect(due(13)).toBe('2025-02-28'); // 平年 2 月没有 29
    expect(due(14)).toBe('2025-03-29'); // 回到 29
  });
});

describe('cycles: 跨年', () => {
  it('月订阅跨年', () => {
    expect(nthDueDate(monthly, '2024-11-30', 1)).toBe('2024-12-30');
    expect(nthDueDate(monthly, '2024-11-30', 2)).toBe('2025-01-30');
    expect(nthDueDate(monthly, '2024-11-30', 3)).toBe('2025-02-28');
  });

  it('12 月 31 日开始的季度 / 年订阅', () => {
    expect(nthDueDate(quarterly, '2024-12-31', 1)).toBe('2025-03-31');
    expect(nthDueDate(quarterly, '2024-12-31', 2)).toBe('2025-06-30');
    expect(nthDueDate(yearly, '2024-12-31', 1)).toBe('2025-12-31');
  });

  it('7 月 15 日开始的半年订阅跨到次年', () => {
    expect(nthDueDate(halfYearly, '2024-07-15', 1)).toBe('2025-01-15');
    expect(nthDueDate(halfYearly, '2024-07-15', 2)).toBe('2025-07-15');
  });
});

describe('cycles: 固定天数', () => {
  it('就是纯粹加天数，不受月份长度影响', () => {
    const due = (i: number) => nthDueDate(every(30), '2024-01-01', i);
    expect(due(0)).toBe('2024-01-01');
    expect(due(1)).toBe('2024-01-31');
    expect(due(2)).toBe('2024-03-01'); // 1/31 + 30 天 => 3/1（不是 3/2）
  });

  it('每 7 天', () => {
    const due = (i: number) => nthDueDate(every(7), '2024-01-01', i);
    expect(due(1)).toBe('2024-01-08');
    expect(due(52)).toBe('2024-12-30'); // 2024 是闰年，第 365 天是 12/30
    expect(due(53)).toBe('2025-01-06');
  });

  it('每天，跨过闰日', () => {
    const due = (i: number) => nthDueDate(every(1), '2024-02-27', i);
    expect(due(1)).toBe('2024-02-28');
    expect(due(2)).toBe('2024-02-29');
    expect(due(3)).toBe('2024-03-01');
  });
});

describe('cycles: 终身订阅', () => {
  it('没有下一次到期', () => {
    expect(nthDueDate(lifetime, '2024-01-01', 0)).toBeNull();
    expect(nthDueDate(lifetime, '2024-01-01', 5)).toBeNull();
    expect(nextDueDate(lifetime, '2024-01-01', '2024-06-01')).toBeNull();
    expect(previousDueDate(lifetime, '2024-01-01', '2024-06-01')).toBeNull();
    expect(dueDatesBetween(lifetime, '2024-01-01', '2024-06-01', '2024-07-01')).toEqual([]);
  });
});

describe('cycles: nextDueDate', () => {
  it('到期日当天返回当天', () => {
    expect(nextDueDate(monthly, '2024-01-31', '2024-02-29')).toBe('2024-02-29');
    expect(nextDueDate(monthly, '2024-01-15', '2024-03-15')).toBe('2024-03-15');
  });

  it('到期日之前返回本期到期日', () => {
    expect(nextDueDate(monthly, '2024-01-31', '2024-02-15')).toBe('2024-02-29');
    expect(nextDueDate(monthly, '2024-01-15', '2024-03-01')).toBe('2024-03-15');
  });

  it('到期日之后返回下一期', () => {
    expect(nextDueDate(monthly, '2024-01-31', '2024-03-01')).toBe('2024-03-31');
    expect(nextDueDate(monthly, '2024-01-31', '2024-03-31')).toBe('2024-03-31'); // 又是当天
    expect(nextDueDate(monthly, '2024-01-31', '2024-04-01')).toBe('2024-04-30');
  });

  it('还没开始订阅时返回首次到期日', () => {
    expect(nextDueDate(monthly, '2024-06-15', '2024-01-01')).toBe('2024-06-15');
    expect(nextDueDate(monthly, '2024-06-15', '2024-06-15')).toBe('2024-06-15');
  });

  it('固定天数', () => {
    expect(nextDueDate(every(30), '2024-01-01', '2024-02-15')).toBe('2024-03-01');
    expect(nextDueDate(every(7), '2024-01-01', '2024-01-01')).toBe('2024-01-01');
    expect(nextDueDate(every(7), '2024-01-01', '2024-01-02')).toBe('2024-01-08');
  });

  it('年订阅跨越闰年', () => {
    expect(nextDueDate(yearly, '2024-02-29', '2025-01-01')).toBe('2025-02-28');
    expect(nextDueDate(yearly, '2024-02-29', '2025-03-01')).toBe('2026-02-28');
  });

  it('已取消 -> null', () => {
    expect(
      nextDueDate(monthly, '2024-01-15', '2024-03-01', { cancelledAt: '2024-02-01T00:00:00.000Z' }),
    ).toBeNull();
  });

  it('超过结束日 -> null；未超过则正常', () => {
    expect(nextDueDate(monthly, '2024-01-15', '2024-03-01', { endDate: '2024-02-20' })).toBeNull();
    expect(nextDueDate(monthly, '2024-01-15', '2024-02-16', { endDate: '2024-03-15' })).toBe(
      '2024-03-15',
    );
    // 下一次到期在结束日之后 -> 没有下一次
    expect(nextDueDate(monthly, '2024-01-15', '2024-02-16', { endDate: '2024-03-01' })).toBeNull();
  });
});

describe('cycles: previousDueDate（手动续费判定用）', () => {
  it('落在两期之间', () => {
    expect(previousDueDate(monthly, '2024-01-31', '2024-03-15')).toBe('2024-02-29');
    expect(previousDueDate(monthly, '2024-01-15', '2024-03-20')).toBe('2024-03-15');
  });

  it('正好在到期日当天时返回当天', () => {
    expect(previousDueDate(monthly, '2024-01-31', '2024-02-29')).toBe('2024-02-29');
    expect(previousDueDate(monthly, '2024-01-15', '2024-03-15')).toBe('2024-03-15');
  });

  it('还没到首次到期日时返回 null', () => {
    expect(previousDueDate(monthly, '2024-06-15', '2024-01-01')).toBeNull();
    expect(previousDueDate(monthly, '2024-06-15', '2024-06-14')).toBeNull();
  });
});

describe('cycles: dueDatesBetween（左开右闭）', () => {
  it('月末锚点订阅在未来窗口内的到期日', () => {
    expect(
      dueDatesBetween(monthly, '2024-01-31', '2024-01-31', '2024-04-30'),
    ).toEqual(['2024-02-29', '2024-03-31', '2024-04-30']);
  });

  it('左开：起始日当天的到期日不被计入', () => {
    expect(dueDatesBetween(monthly, '2024-01-15', '2024-01-15', '2024-03-15')).toEqual([
      '2024-02-15',
      '2024-03-15',
    ]);
  });

  it('右闭：结束日当天的到期日会被计入', () => {
    expect(dueDatesBetween(monthly, '2024-01-15', '2024-01-15', '2024-03-14')).toEqual([
      '2024-02-15',
    ]);
  });

  it('固定天数在一个月里可能出现多次', () => {
    expect(dueDatesBetween(every(7), '2024-01-01', '2024-01-01', '2024-02-01')).toEqual([
      '2024-01-08',
      '2024-01-15',
      '2024-01-22',
      '2024-01-29',
    ]);
  });

  it('未来 30 天窗口', () => {
    // 窗口 (2024-01-15, 2024-02-14]：下一次 02-15 落在窗口之外
    expect(dueDatesBetween(monthly, '2024-01-15', '2024-01-15', '2024-02-14')).toEqual([]);
    // 右端再放宽一天就进来了
    expect(dueDatesBetween(monthly, '2024-01-15', '2024-01-15', '2024-02-15')).toEqual([
      '2024-02-15',
    ]);
  });

  it('结束日之后不再产生到期日', () => {
    expect(
      dueDatesBetween(monthly, '2024-01-15', '2024-01-15', '2024-06-01', { endDate: '2024-03-01' }),
    ).toEqual(['2024-02-15']);
  });

  it('已取消 -> 空', () => {
    expect(
      dueDatesBetween(monthly, '2024-01-15', '2024-01-15', '2024-06-01', {
        cancelledAt: '2024-02-01T00:00:00.000Z',
      }),
    ).toEqual([]);
  });
});

describe('cycles: dueIndexOnOrAfter', () => {
  it('定位到期日下标', () => {
    expect(dueIndexOnOrAfter(monthly, '2024-01-31', '2024-01-01')).toBe(0);
    expect(dueIndexOnOrAfter(monthly, '2024-01-31', '2024-01-31')).toBe(0);
    expect(dueIndexOnOrAfter(monthly, '2024-01-31', '2024-02-01')).toBe(1);
    expect(dueIndexOnOrAfter(monthly, '2024-01-31', '2024-02-29')).toBe(1);
    expect(dueIndexOnOrAfter(monthly, '2024-01-31', '2024-03-01')).toBe(2);
    expect(dueIndexOnOrAfter(yearly, '2024-02-29', '2025-01-01')).toBe(1);
    expect(dueIndexOnOrAfter(every(7), '2024-01-01', '2024-01-08')).toBe(1);
    expect(dueIndexOnOrAfter(every(7), '2024-01-01', '2024-01-09')).toBe(2);
  });

  it('与 nthDueDate 自洽：结果一定 >= 目标日，且前一期一定 < 目标日', () => {
    const cases: Array<[CycleSpec, string, string]> = [
      [monthly, '2024-01-31', '2024-07-15'],
      [quarterly, '2024-08-31', '2025-03-01'],
      [yearly, '2024-02-29', '2027-06-15'],
      [every(45), '2024-01-01', '2024-08-20'],
      [halfYearly, '2023-11-30', '2025-01-01'],
    ];
    for (const [spec, start, target] of cases) {
      const i = dueIndexOnOrAfter(spec, start, target);
      const due = nthDueDate(spec, start, i);
      expect(due).not.toBeNull();
      expect(due! >= target).toBe(true);
      if (i > 0) {
        expect(nthDueDate(spec, start, i - 1)! < target).toBe(true);
      }
    }
  });
});

describe('cycles: 参数防御', () => {
  it('非法日期直接抛错', () => {
    expect(() => nthDueDate(monthly, '2024-02-30', 0)).toThrow(RangeError);
    expect(() => nextDueDate(monthly, '2024-01-01', 'not-a-date')).toThrow(RangeError);
    expect(() => nthDueDate(monthly, '2024-01-01', -1)).toThrow(RangeError);
    expect(() => nthDueDate(monthly, '2024-01-01', 1.5)).toThrow(RangeError);
  });
});
