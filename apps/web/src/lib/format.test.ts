import { describe, expect, it } from 'vitest';
import {
  chargeSourceLabel,
  chargeStatusLabel,
  formatDate,
  formatDateShort,
  formatHoursAgo,
  formatInstant,
  formatMoney,
  formatMonth,
  formatMonthAxis,
  fxNotices,
  inputToMinor,
  minorToInput,
  relativeDays,
  renewModeLabel,
  statusLabel,
  statusTone,
} from './format';

describe('format: 金额', () => {
  it('整数最小单位 -> 带币种符号的文本（不假设 ICU 的具体符号）', () => {
    expect(formatMoney(2500, 'CNY')).toContain('25.00');
    const jpy = formatMoney(1200, 'JPY');
    expect(jpy).toContain('1,200');
    expect(jpy).not.toContain('.');
  });

  it('null / undefined 退化成破折号，而不是 0', () => {
    expect(formatMoney(null, 'CNY')).toBe('—');
    expect(formatMoney(undefined, 'CNY')).toBe('—');
    expect(formatMoney(Number.NaN, 'CNY')).toBe('—');
  });

  it('语法合法但未知的币种按 2 位小数展示，不抛异常', () => {
    expect(formatMoney(1234, 'RMB')).toContain('12.34');
  });

  it('负数（退款）保留符号', () => {
    expect(formatMoney(-1680, 'CNY')).toContain('-');
    expect(formatMoney(-1680, 'CNY')).toContain('16.80');
  });

  it('inputToMinor 严格校验精度与空值（宁可报错也不静默丢钱）', () => {
    expect(inputToMinor('25.00', 'CNY')).toEqual({ ok: true, value: 2500 });
    expect(inputToMinor('1200', 'JPY')).toEqual({ ok: true, value: 1200 });
    expect(inputToMinor('1.234', 'KWD')).toEqual({ ok: true, value: 1234 });

    expect(inputToMinor('25.005', 'CNY').ok).toBe(false);
    expect(inputToMinor('', 'CNY').ok).toBe(false);
    expect(inputToMinor('1,200', 'JPY').ok).toBe(false);
    expect(inputToMinor('abc', 'CNY').ok).toBe(false);
  });

  it('minorToInput 与 inputToMinor 往返一致', () => {
    expect(minorToInput(2500, 'CNY')).toBe('25.00');
    expect(minorToInput(1200, 'JPY')).toBe('1200');
    expect(minorToInput(1234, 'KWD')).toBe('1.234');
    expect(minorToInput(null, 'CNY')).toBe('');
  });
});

describe('format: 日期', () => {
  it('长/短日期格式', () => {
    expect(formatDate('2026-03-04')).toBe('2026年3月4日');
    expect(formatDate(null)).toBe('—');
    expect(formatDate('坏数据')).toBe('坏数据');
    expect(formatDateShort('2026-03-04', '2026-10-10')).toBe('3月4日');
    expect(formatDateShort('2026-03-04', '2025-10-10')).toBe('2026年3月4日');
  });

  it('月份与图表短标签', () => {
    expect(formatMonth('2026-03')).toBe('2026年3月');
    expect(formatMonthAxis('2026-03', 2026)).toBe('3月');
    expect(formatMonthAxis('2025-12', 2026)).toBe('25年12月');
  });

  it('距今天数', () => {
    expect(relativeDays('2026-10-10', '2026-10-10')).toBe('今天');
    expect(relativeDays('2026-10-11', '2026-10-10')).toBe('明天');
    expect(relativeDays('2026-10-13', '2026-10-10')).toBe('3 天后');
    expect(relativeDays('2026-10-08', '2026-10-10')).toBe('已过期 2 天');
    expect(relativeDays(null, '2026-10-10')).toBe('—');
  });

  it('小时数', () => {
    expect(formatHoursAgo(0.4)).toBe('刚刚');
    expect(formatHoursAgo(3)).toBe('3 小时前');
    expect(formatHoursAgo(50)).toBe('2 天前');
    expect(formatHoursAgo(null)).toBe('未知');
  });

  it('UTC 时间点按指定时区展示', () => {
    expect(formatInstant('2026-10-10T02:00:00.000Z', 'Asia/Shanghai')).toBe('2026-10-10 10:00');
    expect(formatInstant(null)).toBe('—');
  });
});

describe('format: 中文标签', () => {
  it('状态 / 扣款状态 / 来源 / 续费方式', () => {
    expect(statusLabel('anomaly')).toBe('异常');
    expect(statusTone('anomaly')).toBe('danger');
    expect(statusTone('ended')).toBe('muted');
    expect(statusTone('active')).toBe('ok');
    expect(chargeStatusLabel('paid')).toBe('已支付');
    expect(chargeStatusLabel('refunded')).toBe('已退款');
    expect(chargeSourceLabel('auto')).toBe('自动扣款');
    expect(renewModeLabel('manual')).toBe('手动续费');
  });
});

describe('format: 汇率健康度提示（需求点名）', () => {
  const healthy = {
    stale: false,
    fxAsOf: '2026-10-10T02:00:00.000Z',
    fxAgeHours: 1,
    missingCurrencies: [] as string[],
    baseCurrency: 'CNY',
  };

  it('一切正常时不提示', () => {
    expect(fxNotices(healthy)).toEqual([]);
  });

  it('缺币种时给 danger 提示，并说明合计不是 0', () => {
    const notices = fxNotices({ ...healthy, missingCurrencies: ['USD', 'JPY'] });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.level).toBe('danger');
    expect(notices[0]?.title).toContain('USD');
    expect(notices[0]?.title).toContain('JPY');
    expect(notices[0]?.title).toContain('合计无法计算');
    expect(notices[0]?.detail).toContain('而不是少算');
  });

  it('汇率过期给 warn，并带上距今天数', () => {
    const notices = fxNotices({ ...healthy, stale: true, fxAgeHours: 72 });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.level).toBe('warn');
    expect(notices[0]?.title).toContain('3 天前');
    expect(notices[0]?.title).toContain('48 小时');
  });

  it('从来没有汇率快照时升级成 danger', () => {
    const notices = fxNotices({ ...healthy, stale: true, fxAsOf: null, fxAgeHours: null });
    expect(notices[0]?.level).toBe('danger');
    expect(notices[0]?.title).toContain('从未更新过');
    expect(notices[0]?.detail).toContain('还没有任何汇率快照');
  });

  it('缺币种 + 过期可以同时出现（两条独立提示）', () => {
    const notices = fxNotices({ ...healthy, stale: true, fxAgeHours: 100, missingCurrencies: ['USD'] });
    expect(notices).toHaveLength(2);
    expect(notices.map((n) => n.level)).toEqual(['danger', 'warn']);
  });
});
