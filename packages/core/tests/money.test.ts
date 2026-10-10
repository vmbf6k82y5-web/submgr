import { describe, expect, it } from 'vitest';
import {
  convert,
  convertWithFrozenRate,
  currencyExponent,
  formatMinorAmount,
  fromMajorString,
  frozenRateBetween,
  hasRate,
  isKnownCurrency,
  minorUnitsPerMajor,
  normalizeCurrency,
  parseDecimalToRational,
  rateToUsd,
  ratioMinor,
  roundHalfAwayFromZero,
  toMajorString,
} from '../src/money.js';
import { TEST_RATES, makeFxSnapshot } from './fixtures.js';

describe('money: ISO 4217 小数位', () => {
  it('常见币种是 2 位', () => {
    expect(currencyExponent('CNY')).toBe(2);
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('EUR')).toBe(2);
    expect(currencyExponent('HKD')).toBe(2);
  });

  it('日元是 0 位（没有分）', () => {
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KRW')).toBe(0);
    expect(currencyExponent('VND')).toBe(0);
    expect(currencyExponent('CLP')).toBe(0);
    expect(currencyExponent('ISK')).toBe(0);
    expect(minorUnitsPerMajor('JPY')).toBe(1);
  });

  it('科威特第纳尔是 3 位', () => {
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('BHD')).toBe(3);
    expect(currencyExponent('OMR')).toBe(3);
    expect(currencyExponent('TND')).toBe(3);
    expect(currencyExponent('JOD')).toBe(3);
    expect(minorUnitsPerMajor('KWD')).toBe(1000);
  });

  it('还有 4 位的币种', () => {
    expect(currencyExponent('CLF')).toBe(4);
    expect(currencyExponent('UYW')).toBe(4);
  });

  it('大小写不敏感', () => {
    expect(currencyExponent('jpy')).toBe(0);
    expect(currencyExponent(' kwd ')).toBe(3);
  });

  it('未知币种按 2 位处理且被标记为未知', () => {
    expect(isKnownCurrency('CNY')).toBe(true);
    expect(isKnownCurrency('JPY')).toBe(true);
    expect(isKnownCurrency('ZZQ')).toBe(false);
    expect(currencyExponent('ZZQ')).toBe(2); // 不抛错，保证链路不崩
  });

  it('语法非法（不是 3 位字母）的币种代码抛错', () => {
    expect(() => currencyExponent('CN')).toThrow(RangeError);
    expect(() => currencyExponent('CNYY')).toThrow(RangeError);
    expect(() => currencyExponent('12A')).toThrow(RangeError);
    expect(() => currencyExponent('')).toThrow(RangeError);
    expect(() => normalizeCurrency('')).toThrow(RangeError);
    expect(() => normalizeCurrency(null as unknown as string)).toThrow(RangeError);
  });

  it('语法合法但不是 ISO 4217 的代码不抛错，按 2 位处理并标记为未知', () => {
    // 'RMB' 是常见写法但不是 ISO 代码（ISO 里是 CNY）
    expect(isKnownCurrency('RMB')).toBe(false);
    expect(currencyExponent('RMB')).toBe(2);
    // 未知币种仍然可以参与换算，保证遇到新币种时链路不崩
    expect(convert(100, 'RMB', 'CNY', { RMB: '7.14', CNY: '7.14' })).toBe(100);
  });
});

describe('money: 主单位与最小单位互转', () => {
  it('人民币：分 <-> 元', () => {
    expect(toMajorString(2500, 'CNY')).toBe('25.00');
    expect(toMajorString(5, 'CNY')).toBe('0.05');
    expect(toMajorString(0, 'CNY')).toBe('0.00');
    expect(toMajorString(-2500, 'CNY')).toBe('-25.00');
    expect(fromMajorString('25.00', 'CNY')).toBe(2500);
    expect(fromMajorString('25', 'CNY')).toBe(2500);
    expect(fromMajorString('0.05', 'CNY')).toBe(5);
    expect(fromMajorString('-25.00', 'CNY')).toBe(-2500);
  });

  it('日元：没有小数位', () => {
    expect(toMajorString(1200, 'JPY')).toBe('1200');
    expect(toMajorString(0, 'JPY')).toBe('0');
    expect(fromMajorString('1200', 'JPY')).toBe(1200);
    expect(fromMajorString('1200.00', 'JPY')).toBe(1200); // 允许补零
  });

  it('第纳尔：3 位小数', () => {
    expect(toMajorString(1234, 'KWD')).toBe('1.234');
    expect(toMajorString(1, 'KWD')).toBe('0.001');
    expect(toMajorString(1000, 'KWD')).toBe('1.000');
    expect(fromMajorString('1.234', 'KWD')).toBe(1234);
    expect(fromMajorString('1', 'KWD')).toBe(1000);
  });

  it('小数位超限时抛错，不静默丢钱', () => {
    expect(() => fromMajorString('25.001', 'CNY')).toThrow(RangeError);
    expect(() => fromMajorString('1200.5', 'JPY')).toThrow(RangeError);
    expect(() => fromMajorString('1.2345', 'KWD')).toThrow(RangeError);
    expect(() => fromMajorString('abc', 'CNY')).toThrow(TypeError);
  });

  it('金额必须是整数最小单位', () => {
    expect(() => toMajorString(25.5, 'CNY')).toThrow(TypeError);
    expect(() => convert(25.5, 'CNY', 'USD', TEST_RATES)).toThrow(TypeError);
  });

  it('格式化带币种符号', () => {
    const text = formatMinorAmount(2500, 'CNY', 'zh-CN');
    expect(text).toContain('25.00');
    const jpy = formatMinorAmount(1200, 'JPY', 'zh-CN');
    expect(jpy).toContain('1,200');
    expect(jpy).not.toContain('.');
  });
});

describe('money: 舍入规则', () => {
  it('.5 一律远离零', () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(roundHalfAwayFromZero(1.4)).toBe(1);
    expect(roundHalfAwayFromZero(1.6)).toBe(2);
    expect(roundHalfAwayFromZero(0)).toBe(0);
  });

  it('ratioMinor 精确折算', () => {
    expect(ratioMinor(5, 1, 2)).toBe(3); // 2.5 -> 3
    expect(ratioMinor(-5, 1, 2)).toBe(-3);
    expect(ratioMinor(7, 1, 2)).toBe(4); // 3.5 -> 4
    expect(ratioMinor(1, 1, 3)).toBe(0);
    expect(ratioMinor(2, 1, 3)).toBe(1); // 0.667 -> 1
    expect(ratioMinor(10000, 1, 3)).toBe(3333);
    expect(ratioMinor(0, 1, 3)).toBe(0);
  });

  it('ratioMinor 用大整数也不会因浮点失真', () => {
    // 9007199254740991 / 3 = 3002399751580330.333... -> 3002399751580330
    expect(ratioMinor(9007199254740991, 1, 3)).toBe(3002399751580330);
  });

  it('ratioMinor 参数防御', () => {
    expect(() => ratioMinor(100, 1, 0)).toThrow(RangeError);
    expect(() => ratioMinor(100, 1, -2)).toThrow(RangeError);
    expect(() => ratioMinor(1.5, 1, 2)).toThrow(TypeError);
  });
});

describe('money: 十进制解析', () => {
  it('解析为精确有理数', () => {
    expect(parseDecimalToRational('7.1420')).toEqual({ n: 71420n, d: 10000n });
    expect(parseDecimalToRational('1')).toEqual({ n: 1n, d: 1n });
    expect(parseDecimalToRational('0.5')).toEqual({ n: 5n, d: 10n });
    expect(parseDecimalToRational('-2.25')).toEqual({ n: -225n, d: 100n });
    expect(parseDecimalToRational('1e3')).toEqual({ n: 1000n, d: 1n });
    expect(parseDecimalToRational('1e-3')).toEqual({ n: 1n, d: 1000n });
  });

  it('非法输入返回 null（视为缺汇率）', () => {
    expect(parseDecimalToRational('abc')).toBeNull();
    expect(parseDecimalToRational('')).toBeNull();
    expect(parseDecimalToRational('7.1.1')).toBeNull();
  });
});

describe('money: 汇率取值', () => {
  it('USD 隐含为 1，即使汇率表里没有 USD', () => {
    expect(rateToUsd('USD', TEST_RATES)).toEqual({ n: 1n, d: 1n });
    expect(hasRate('USD', {})).toBe(true);
    expect(rateToUsd('USD', {})).toEqual({ n: 1n, d: 1n });
    expect(TEST_RATES.USD).toBeUndefined(); // 测试数据本身确实不含 USD
  });

  it('缺失或非法的汇率返回 null', () => {
    expect(rateToUsd('JPY', { CNY: '7.14' })).toBeNull();
    expect(rateToUsd('JPY', { JPY: '' })).toBeNull();
    expect(rateToUsd('JPY', { JPY: 'abc' })).toBeNull();
    expect(rateToUsd('JPY', { JPY: '0' })).toBeNull();
    expect(rateToUsd('JPY', { JPY: '-1' })).toBeNull();
    expect(hasRate('JPY', { CNY: '7.14' })).toBe(false);
  });
});

describe('money: convert（经 USD 交叉换算）', () => {
  const rates = makeFxSnapshot(TEST_RATES);

  it('同币种原样返回', () => {
    expect(convert(2500, 'CNY', 'CNY', rates)).toBe(2500);
    expect(convert(2500, 'cny', 'CNY', rates)).toBe(2500);
    expect(convert(0, 'JPY', 'JPY', rates)).toBe(0);
  });

  it('USD <-> CNY', () => {
    // 1000 美分 = $10.00 -> ¥71.40 = 7140 分
    expect(convert(1000, 'USD', 'CNY', rates)).toBe(7140);
    expect(convert(7140, 'CNY', 'USD', rates)).toBe(1000);
  });

  it('JPY -> CNY：正确处理 0 位小数', () => {
    // 100 分人民币 = ¥1.00 -> 1/7.14*157.2 = 22.0168... 日元 -> 22
    expect(convert(100, 'CNY', 'JPY', rates)).toBe(22);
    // 反向：22 日元 -> 0.99923... 元 -> 99.92 分 -> 100 分
    expect(convert(22, 'JPY', 'CNY', rates)).toBe(100);
  });

  it('KWD -> CNY：正确处理 3 位小数', () => {
    // 1000 fils = 1.000 KWD -> 1/0.3065 USD -> *7.14 CNY = 23.2952... 元 -> 2330 分
    expect(convert(1000, 'KWD', 'CNY', rates)).toBe(2330);
  });

  it('JPY -> KWD：两种不同小数位之间直接换算', () => {
    // 10000 日元 -> 10000/157.2 USD -> *0.3065 KWD = 19.4974... KWD -> 19497 fils
    expect(convert(10000, 'JPY', 'KWD', rates)).toBe(19497);
  });

  it('JPY -> USD：0 位到 2 位', () => {
    // 157 日元 = 1 USD = 100 美分
    expect(convert(157, 'JPY', 'USD', rates)).toBe(100);
    // 1 日元 = 0.636 美分 -> 1
    expect(convert(1, 'JPY', 'USD', rates)).toBe(1);
  });

  it('四舍五入在 .5 时远离零', () => {
    // 1 USD = 2 SGD，1 USD = 1 HKD
    // 1 SGD 分 = 0.01 SGD -> 0.005 USD -> 0.005 HKD = 0.5 HKD 分 -> 进位到 1
    expect(convert(1, 'SGD', 'HKD', { SGD: '2', HKD: '1' })).toBe(1);
    expect(convert(-1, 'SGD', 'HKD', { SGD: '2', HKD: '1' })).toBe(-1);
    // 9 SGD 分 = 0.09 SGD -> 0.045 USD -> 0.045 HKD = 4.5 HKD 分 -> 进位到 5
    expect(convert(9, 'SGD', 'HKD', { SGD: '2', HKD: '1' })).toBe(5);
    // 7 SGD 分 = 0.035 HKD = 3.5 分 -> 4
    expect(convert(7, 'SGD', 'HKD', { SGD: '2', HKD: '1' })).toBe(4);
    // 5 SGD 分 = 0.025 HKD = 2.5 分 -> 3
    expect(convert(5, 'SGD', 'HKD', { SGD: '2', HKD: '1' })).toBe(3);
  });

  it('缺任一币种的汇率 -> null（绝不当成 0 或跳过）', () => {
    expect(convert(100, 'JPY', 'CNY', { CNY: '7.14' })).toBeNull();
    expect(convert(100, 'CNY', 'JPY', { CNY: '7.14' })).toBeNull();
    expect(convert(100, 'JPY', 'CNY', {})).toBeNull();
    expect(convert(100, 'JPY', 'KWD', { CNY: '7.14' })).toBeNull();
  });

  it('金额为 0 时即使缺汇率也返回 null（保持「缺汇率」语义一致）', () => {
    expect(convert(0, 'JPY', 'CNY', {})).toBeNull();
  });

  it('未知币种默认 2 位小数，仍能换算', () => {
    // 1 USD = 100 ZZQ，1 USD = 7.14 CNY -> 1 ZZQ 分 = 0.01/100*7.14 元 = 0.0714 分 -> 0
    expect(convert(1, 'ZZQ', 'CNY', { ZZQ: '100', CNY: '7.14' })).toBe(0);
    expect(convert(100, 'ZZQ', 'CNY', { ZZQ: '100', CNY: '7.14' })).toBe(7);
  });
});

describe('money: 冻结汇率（已发生的扣款）', () => {
  it('用扣款当天的汇率还原基准金额', () => {
    // 种子数据里的 Netflix：2299 美分 × 7.1420 = 16419.458 分 -> 16419
    expect(convertWithFrozenRate(2299, 'USD', 'CNY', '7.1420')).toBe(16419);
    expect(convertWithFrozenRate(2299, 'USD', 'CNY', '7.0980')).toBe(16318);
    expect(convertWithFrozenRate(2299, 'USD', 'CNY', '7.2150')).toBe(16587);
    expect(convertWithFrozenRate(2299, 'USD', 'CNY', '7.1690')).toBe(16482);
  });

  it('同币种直接返回原值', () => {
    expect(convertWithFrozenRate(2500, 'CNY', 'CNY', '1')).toBe(2500);
    expect(convertWithFrozenRate(1200, 'JPY', 'JPY', '1')).toBe(1200);
  });

  it('不同小数位', () => {
    // 10000 日元 @ 0.0019547 KWD/JPY（1 日元 = 0.3065/157.2 KWD）
    // 10000 * 0.3065/157.2 = 19.49745... KWD -> 19497 fils
    expect(convertWithFrozenRate(10000, 'JPY', 'KWD', '0.001949745547073791')).toBe(19497);
  });

  it('汇率非法 -> null', () => {
    expect(convertWithFrozenRate(100, 'USD', 'CNY', '0')).toBeNull();
    expect(convertWithFrozenRate(100, 'USD', 'CNY', 'abc')).toBeNull();
    expect(convertWithFrozenRate(100, 'USD', 'CNY', '-1')).toBeNull();
  });

  it('frozenRateBetween 生成可回写的字符串汇率', () => {
    expect(frozenRateBetween('CNY', 'CNY', TEST_RATES)).toBe('1');
    expect(frozenRateBetween('USD', 'CNY', TEST_RATES)).toBe('7.14');
    expect(frozenRateBetween('CNY', 'USD', TEST_RATES)).toBe('0.140056022409');
    // 往返自洽：用它生成的汇率换算回去，误差不超过 1 个最小单位
    const rate = frozenRateBetween('USD', 'CNY', TEST_RATES)!;
    expect(convertWithFrozenRate(10000, 'USD', 'CNY', rate)).toBe(71400);
    expect(frozenRateBetween('JPY', 'CNY', {})).toBeNull();
  });
});
