import { afterEach, describe, expect, it } from 'vitest';
import {
  addDaysDateOnly,
  addMonthsKeepingAnchorDay,
  atTimeInTimeZoneToUtc,
  compareDateOnly,
  dayOfMonth,
  diffDaysDateOnly,
  formatDateOnly,
  isValidDateOnly,
  isValidTimeHHmm,
  isValidTimeZone,
  parseDateOnly,
  startOfMonthDateOnly,
  timeInTimeZoneToHHmm,
  todayInTimeZone,
} from '../src/time.js';

describe('time: date-only 校验', () => {
  it('接受合法的日期', () => {
    expect(isValidDateOnly('2024-01-31')).toBe(true);
    expect(isValidDateOnly('2024-02-29')).toBe(true); // 闰年
    expect(isValidDateOnly('2023-02-28')).toBe(true);
    expect(isValidDateOnly('2024-12-31')).toBe(true);
  });

  it('拒绝格式不对的输入', () => {
    expect(isValidDateOnly('2024-1-31')).toBe(false);
    expect(isValidDateOnly('24-01-31')).toBe(false);
    expect(isValidDateOnly('2024/01/31')).toBe(false);
    expect(isValidDateOnly('2024-01-31T00:00:00Z')).toBe(false);
    expect(isValidDateOnly('')).toBe(false);
    expect(isValidDateOnly(null)).toBe(false);
    expect(isValidDateOnly(20240131)).toBe(false);
  });

  it('拒绝不存在的日期（而不是静默顺延）', () => {
    expect(isValidDateOnly('2023-02-29')).toBe(false); // 平年没有 2/29
    expect(isValidDateOnly('2024-02-30')).toBe(false);
    expect(isValidDateOnly('2024-04-31')).toBe(false);
    expect(isValidDateOnly('2024-13-01')).toBe(false);
    expect(isValidDateOnly('2024-00-10')).toBe(false);
    expect(isValidDateOnly('2024-01-00')).toBe(false);
    expect(() => parseDateOnly('2024-02-30')).toThrow(RangeError);
  });

  it('HH:mm 校验', () => {
    expect(isValidTimeHHmm('00:00')).toBe(true);
    expect(isValidTimeHHmm('09:30')).toBe(true);
    expect(isValidTimeHHmm('23:59')).toBe(true);
    expect(isValidTimeHHmm('24:00')).toBe(false);
    expect(isValidTimeHHmm('9:30')).toBe(false);
    expect(isValidTimeHHmm('09:60')).toBe(false);
  });

  it('IANA 时区校验', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('time: 解析与格式化', () => {
  it('往返一致', () => {
    for (const d of ['2024-01-01', '2024-02-29', '2024-12-31', '1999-07-04']) {
      expect(formatDateOnly(parseDateOnly(d))).toBe(d);
    }
  });

  it('加减天数', () => {
    expect(addDaysDateOnly('2024-02-28', 1)).toBe('2024-02-29'); // 闰年
    expect(addDaysDateOnly('2023-02-28', 1)).toBe('2023-03-01'); // 平年
    expect(addDaysDateOnly('2024-12-31', 1)).toBe('2025-01-01'); // 跨年
    expect(addDaysDateOnly('2024-01-01', -1)).toBe('2023-12-31');
    expect(addDaysDateOnly('2024-03-01', -1)).toBe('2024-02-29');
  });

  it('日期差值', () => {
    expect(diffDaysDateOnly('2024-03-01', '2024-02-01')).toBe(29); // 闰年 2 月
    expect(diffDaysDateOnly('2023-03-01', '2023-02-01')).toBe(28);
    expect(diffDaysDateOnly('2025-01-01', '2024-12-31')).toBe(1);
    expect(diffDaysDateOnly('2024-01-01', '2024-01-01')).toBe(0);
    expect(diffDaysDateOnly('2024-01-01', '2024-01-31')).toBe(-30);
  });

  it('比较与月份起点', () => {
    expect(compareDateOnly('2024-01-01', '2024-01-02')).toBe(-1);
    expect(compareDateOnly('2024-01-02', '2024-01-02')).toBe(0);
    expect(compareDateOnly('2024-01-03', '2024-01-02')).toBe(1);
    expect(startOfMonthDateOnly('2024-02-29')).toBe('2024-02-01');
    expect(dayOfMonth('2024-02-29')).toBe(29);
  });

  it('锚点日月份偏移：月末回到锚点', () => {
    // 1/31 + 1 月 -> 2/29；+2 月 -> 3/31（回到 31，而不是停在 29）
    expect(addMonthsKeepingAnchorDay('2024-01-31', 1, 31)).toBe('2024-02-29');
    expect(addMonthsKeepingAnchorDay('2024-01-31', 2, 31)).toBe('2024-03-31');
    expect(addMonthsKeepingAnchorDay('2023-01-31', 1, 31)).toBe('2023-02-28');
    expect(addMonthsKeepingAnchorDay('2023-01-31', 2, 31)).toBe('2023-03-31');
    expect(addMonthsKeepingAnchorDay('2024-08-31', 12, 31)).toBe('2025-08-31');
  });
});

describe('time: 用户时区（Asia/Shanghai 午夜前后）', () => {
  it('UTC 15:59 还是上海的今天，UTC 16:00 已经是上海的明天', () => {
    const beforeMidnight = new Date('2025-03-01T15:59:59.000Z'); // 上海 23:59:59
    const afterMidnight = new Date('2025-03-01T16:00:00.000Z'); // 上海 03-02 00:00:00

    expect(todayInTimeZone('Asia/Shanghai', beforeMidnight)).toBe('2025-03-01');
    expect(todayInTimeZone('Asia/Shanghai', afterMidnight)).toBe('2025-03-02');

    // 同一时刻在 UTC 下仍是 03-01，说明确实是按时区算的
    expect(todayInTimeZone('UTC', afterMidnight)).toBe('2025-03-01');
  });

  it('上海跨月/跨年的边界', () => {
    // 上海 2025-01-01 00:00 = UTC 2024-12-31 16:00
    expect(todayInTimeZone('Asia/Shanghai', new Date('2024-12-31T15:59:00Z'))).toBe('2024-12-31');
    expect(todayInTimeZone('Asia/Shanghai', new Date('2024-12-31T16:00:00Z'))).toBe('2025-01-01');
  });

  it('西半球时区的边界（UTC-5 / UTC-4）', () => {
    // 纽约 2025-03-01 23:30 = UTC 2025-03-02 04:30
    expect(todayInTimeZone('America/New_York', new Date('2025-03-02T04:30:00Z'))).toBe('2025-03-01');
    expect(todayInTimeZone('America/New_York', new Date('2025-03-02T05:30:00Z'))).toBe('2025-03-02');
  });

  it('把用户时区的时刻换算成 UTC 瞬间', () => {
    // 上海 2025-03-01 00:00 == UTC 2025-02-28 16:00
    expect(atTimeInTimeZoneToUtc('2025-03-01', '00:00', 'Asia/Shanghai').toISOString()).toBe(
      '2025-02-28T16:00:00.000Z',
    );
    expect(atTimeInTimeZoneToUtc('2025-03-01', '09:30', 'Asia/Shanghai').toISOString()).toBe(
      '2025-03-01T01:30:00.000Z',
    );
    expect(atTimeInTimeZoneToUtc('2025-03-01', '00:00', 'UTC').toISOString()).toBe(
      '2025-03-01T00:00:00.000Z',
    );
  });

  it('夏令时切换前后偏移正确（纽约 2025-03-09 切换）', () => {
    // 切换前：EST = UTC-5，09:00 本地 = 14:00Z
    expect(atTimeInTimeZoneToUtc('2025-03-08', '09:00', 'America/New_York').toISOString()).toBe(
      '2025-03-08T14:00:00.000Z',
    );
    // 切换后：EDT = UTC-4，09:00 本地 = 13:00Z
    expect(atTimeInTimeZoneToUtc('2025-03-10', '09:00', 'America/New_York').toISOString()).toBe(
      '2025-03-10T13:00:00.000Z',
    );
  });

  it('反向格式化 HH:mm', () => {
    expect(timeInTimeZoneToHHmm(new Date('2025-03-01T01:30:00Z'), 'Asia/Shanghai')).toBe('09:30');
    expect(timeInTimeZoneToHHmm(new Date('2025-03-01T01:30:00Z'), 'UTC')).toBe('01:30');
  });
});

describe('time: 结果与进程时区无关', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it('在 UTC / 上海 / 纽约 / 加尔各答下，date-only 运算结果完全一致', () => {
    const zones = ['UTC', 'Asia/Shanghai', 'America/New_York', 'Asia/Kolkata', 'Pacific/Auckland'];
    const observed: Array<Record<string, string>> = [];

    for (const tz of zones) {
      process.env.TZ = tz;
      observed.push({
        tz,
        parseFormatRoundTrip: formatDateOnly(parseDateOnly('2024-01-31')),
        monthEndAnchor: addMonthsKeepingAnchorDay('2024-01-31', 1, 31),
        monthEndAnchorBack: addMonthsKeepingAnchorDay('2024-01-31', 2, 31),
        leapYear: addDaysDateOnly('2024-02-28', 1),
        crossYear: addDaysDateOnly('2024-12-31', 1),
        diff: String(diffDaysDateOnly('2024-03-01', '2024-02-01')),
      });
    }

    const baseline = { ...observed[0] };
    delete (baseline as Record<string, unknown>).tz;
    for (const row of observed) {
      const copy = { ...row };
      delete (copy as Record<string, unknown>).tz;
      expect(copy).toEqual(baseline);
    }

    // 顺便确认时区确实被切换过
    expect(observed.map((r) => r.tz)).toEqual(zones);
  });

  it('即使进程时区是 UTC+8，todayInTimeZone 仍然只看传入的时区', () => {
    process.env.TZ = 'Asia/Shanghai';
    const instant = new Date('2025-03-01T16:00:00.000Z');
    expect(todayInTimeZone('UTC', instant)).toBe('2025-03-01');
    expect(todayInTimeZone('Asia/Shanghai', instant)).toBe('2025-03-02');
  });
});
