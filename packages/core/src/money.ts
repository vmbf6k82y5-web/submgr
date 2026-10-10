/**
 * 订阅管家 —— 金额与汇率换算（纯函数，无浮点存储）
 *
 * 铁律：金额一律用整数表示「该币种的最小单位」。
 *       人民币 25.00 元 = 2500 分；日元 1200 円 = 1200（日元没有分）；
 *       科威特第纳尔 1.234 = 1234 fils。
 *       小数位数完全按 ISO 4217 的 exponent 取，绝不写死 2 位。
 *
 * 换算全部用 BigInt 有理数运算 + 一次四舍五入，
 * 中间步骤不产生浮点误差（例如 0.1 + 0.2 这类问题在金额上不可接受）。
 */

import { FX_BASE, type FxSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// ISO 4217 小数位（exponent）
// ---------------------------------------------------------------------------

/**
 * 完整 ISO 4217 现行货币的小数位数表。
 * 只列出「不是 2 位」的货币，其余在 KNOWN_CURRENCIES 里默认 2 位。
 */
const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  // —— 0 位小数：这些币种没有辅币单位 ——
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // 贵金属 / 特别提款权 / 测试码 / 无货币，均无辅币
  XAG: 0, XAU: 0, XBA: 0, XBB: 0, XBC: 0, XBD: 0, XDR: 0, XPD: 0, XPT: 0,
  XSU: 0, XTS: 0, XUA: 0, XXX: 0,

  // —— 3 位小数 ——
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,

  // —— 4 位小数 ——
  CLF: 4, UYW: 4,
};

/**
 * 现行 ISO 4217 货币代码清单（用于判断「这是不是一个认识的币种」）。
 * 未列出的代码按 2 位小数处理并在 isKnownCurrency 里返回 false。
 */
const TWO_DECIMAL_CURRENCIES: readonly string[] = [
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
  'BAM', 'BBD', 'BDT', 'BGN', 'BMD', 'BND', 'BOB', 'BOV', 'BRL', 'BSD',
  'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHE', 'CHF', 'CHW', 'CNY',
  'COP', 'COU', 'CRC', 'CUC', 'CUP', 'CVE', 'CZK', 'DKK', 'DOP', 'DZD',
  'EGP', 'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP',
  'GMD', 'GTQ', 'GYD', 'HKD', 'HNL', 'HTG', 'HUF', 'IDR', 'ILS', 'INR',
  'IRR', 'JMD', 'KES', 'KGS', 'KHR', 'KPW', 'KYD', 'KZT', 'LAK', 'LBP',
  'LKR', 'LRD', 'LSL', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP',
  'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MXV', 'MYR', 'MZN', 'NAD', 'NGN',
  'NIO', 'NOK', 'NPR', 'NZD', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN',
  'QAR', 'RON', 'RSD', 'RUB', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD',
  'SHP', 'SLE', 'SLL', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL',
  'THB', 'TJS', 'TMT', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'USD',
  'USN', 'UYU', 'UZS', 'VED', 'VES', 'WST', 'XCD', 'YER', 'ZAR', 'ZMW',
  'ZWG', 'ZWL',
];

const KNOWN_CURRENCIES: ReadonlySet<string> = new Set<string>([
  ...Object.keys(CURRENCY_EXPONENTS),
  ...TWO_DECIMAL_CURRENCIES,
]);

const CURRENCY_CODE_RE = /^[A-Z]{3}$/;

/** 归一化并校验币种代码：去空格、转大写、必须是 3 位字母。 */
export function normalizeCurrency(code: string): string {
  const upper = String(code ?? '').trim().toUpperCase();
  if (!CURRENCY_CODE_RE.test(upper)) {
    throw new RangeError(`不是合法的 ISO 4217 币种代码：${JSON.stringify(code)}`);
  }
  return upper;
}

/** 未知币种返回 false（仍按 2 位小数处理，不会抛错）。 */
export function isKnownCurrency(code: string): boolean {
  try {
    return KNOWN_CURRENCIES.has(normalizeCurrency(code));
  } catch {
    return false;
  }
}

/**
 * ISO 4217 小数位数。
 * 未知币种按 2 位处理（绝大多数货币如此），保证不会因为遇到新币种就让整条链路崩掉。
 */
export function currencyExponent(code: string): number {
  const upper = normalizeCurrency(code);
  const exp = CURRENCY_EXPONENTS[upper];
  if (exp !== undefined) return exp;
  return 2;
}

/** 该币种 1 个主单位等于多少个最小单位（10 的 exponent 次方）。 */
export function minorUnitsPerMajor(code: string): number {
  return 10 ** currencyExponent(code);
}

// ---------------------------------------------------------------------------
// 舍入
// ---------------------------------------------------------------------------

/**
 * 四舍五入，且 .5 一律「远离零」。
 * 不用 Math.round，因为 Math.round(-0.5) === -0，对负金额是「向 +∞」而非「远离零」。
 */
export function roundHalfAwayFromZero(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`roundHalfAwayFromZero: 不是有限数：${value}`);
  }
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

interface Rational {
  /** 分子，可负 */
  n: bigint;
  /** 分母，恒 > 0 */
  d: bigint;
}

/**
 * 把十进制字符串解析成精确有理数。
 * 支持 '7.1420'、'-0.5'、'1e-3' 这类写法；
 * 非法输入返回 null（调用方据此判定「缺汇率」）。
 */
export function parseDecimalToRational(value: string): Rational | null {
  if (typeof value !== 'string') return null;
  const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value.trim());
  if (!m) return null;

  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = m[2] ?? '0';
  const fracPart = m[3] ?? '';
  const expPart = m[4] === undefined ? 0 : Number(m[4]);

  if (!Number.isSafeInteger(expPart)) return null;

  let numerator = BigInt(intPart + fracPart);
  let scale = fracPart.length - expPart;
  if (scale < 0) {
    numerator *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { n: sign * numerator, d: 10n ** BigInt(scale) };
}

/** 大整数除法 + 四舍五入（远离零）。den 必须 > 0。 */
function divideRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new RangeError('divideRoundHalfAwayFromZero: 分母必须为正');
  }
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const quotient = abs / denominator;
  const remainder = abs % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * 精确的比例运算：round(amountMinor * numerator / denominator)，用 BigInt 算。
 *
 * 月均 / 年均摊销全靠它：季度除以 3、半年除以 6、按年除以 12、
 * 固定天数乘以 365/12/cycle_days、终身按 amortize_lifetime_months 摊销。
 * 用整数有理数而不是浮点除法，是为了在金额很大时也不会因为 IEEE754 的
 * 表示误差把 .5 的临界值算歪。
 */
export function ratioMinor(
  amountMinor: number,
  numerator: number,
  denominator: number,
): number {
  if (!Number.isInteger(amountMinor)) {
    throw new TypeError(`ratioMinor: 金额必须是整数最小单位，收到 ${amountMinor}`);
  }
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new TypeError('ratioMinor: 分子与分母都必须是整数');
  }
  if (denominator <= 0) {
    throw new RangeError(`ratioMinor: 分母必须为正，收到 ${denominator}`);
  }
  const result = divideRoundHalfAwayFromZero(
    BigInt(amountMinor) * BigInt(numerator),
    BigInt(denominator),
  );
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('ratioMinor: 结果超出安全整数范围');
  }
  return Number(result);
}

// ---------------------------------------------------------------------------
// 主单位 <-> 最小单位
// ---------------------------------------------------------------------------

/**
 * 整数最小单位 -> 主单位字符串（用于展示，不参与任何计算）。
 * toMajorString(2500, 'CNY') === '25.00'
 * toMajorString(1200, 'JPY') === '1200'
 * toMajorString(1234, 'KWD') === '1.234'
 */
export function toMajorString(amountMinor: number, currency: string): string {
  if (!Number.isInteger(amountMinor)) {
    throw new TypeError(`toMajorString: 金额必须是整数最小单位，收到 ${amountMinor}`);
  }
  const exp = currencyExponent(currency);
  const negative = amountMinor < 0;
  const digits = String(Math.abs(amountMinor)).padStart(exp + 1, '0');
  const sign = negative ? '-' : '';
  if (exp === 0) return `${sign}${digits}`;
  const cut = digits.length - exp;
  return `${sign}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

/**
 * 主单位字符串 -> 整数最小单位。
 * 小数位超过该币种 exponent 会抛错（宁可报错也不要静默丢钱）；
 * 但单纯补零是被允许的，'1200.00' 对日元等价于 '1200'。
 */
export function fromMajorString(major: string, currency: string): number {
  const exp = currencyExponent(currency);
  const m = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(String(major).trim());
  if (!m) {
    throw new TypeError(`fromMajorString: 不是合法的十进制金额：${JSON.stringify(major)}`);
  }
  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = m[2] ?? '0';
  const fracPart = m[3] ?? '';

  // 去掉无意义的尾随零后再判断精度，'25.00' / '1200.00' 这类写法不应该报错
  if (fracPart.replace(/0+$/, '').length > exp) {
    throw new RangeError(
      `fromMajorString: ${currency} 只支持 ${exp} 位小数，收到 ${JSON.stringify(major)}`,
    );
  }

  const frac = fracPart.padEnd(exp, '0').slice(0, exp);
  const digits = intPart + frac;
  const minor = sign * BigInt(digits);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`fromMajorString: 金额超出安全整数范围：${JSON.stringify(major)}`);
  }
  return Number(minor);
}

/** 把整数最小单位格式化成带币种符号的展示文本，例如 '¥25.00'。 */
export function formatMinorAmount(
  amountMinor: number,
  currency: string,
  locale = 'zh-CN',
): string {
  const code = normalizeCurrency(currency);
  const exp = currencyExponent(code);
  const major = toMajorString(amountMinor, code);
  // 只在展示环节接触 Number，且范围受限于安全整数
  const asNumber = Number(major);
  if (!Number.isFinite(asNumber)) {
    throw new RangeError(`formatMinorAmount: 金额过大无法格式化：${major}`);
  }
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: code,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  }).format(asNumber);
}

// ---------------------------------------------------------------------------
// 汇率换算
// ---------------------------------------------------------------------------

export type RatesInput = FxSnapshot | Readonly<Record<string, string>>;

function ratesOf(input: RatesInput): Readonly<Record<string, string>> {
  if (input && typeof input === 'object' && 'rates' in input) {
    return (input as FxSnapshot).rates;
  }
  return input as Readonly<Record<string, string>>;
}

/**
 * 取某币种相对 USD 的汇率（1 USD = ? 该币种）。
 *
 * FX_BASE(USD) 自己视为 1：汇率源返回的 rates 通常不包含基准币种本身，
 * 如果这里不特殊处理，任何以 USD 计价的订阅都会被误判成「缺汇率」。
 *
 * 返回 null 表示缺汇率 / 汇率非法。
 */
export function rateToUsd(currency: string, rates: RatesInput): Rational | null {
  const code = normalizeCurrency(currency);
  if (code === FX_BASE) return { n: 1n, d: 1n };
  const raw = ratesOf(rates)[code];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const parsed = parseDecimalToRational(raw);
  if (parsed === null || parsed.n <= 0n) return null;
  return parsed;
}

/** 某币种是否有可用汇率（USD 永远有）。 */
export function hasRate(currency: string, rates: RatesInput): boolean {
  return rateToUsd(currency, rates) !== null;
}

/**
 * 金额换算：amountMinor（from 的最小单位）-> to 的最小单位。
 *
 * 走 USD 做交叉换算：
 *   major_to = (amountMinor / 10^exp(from)) / rate(from) * rate(to)
 *   minor_to = major_to * 10^exp(to)
 *
 * 全程 BigInt 有理数，最后一次四舍五入；不同币种的小数位差异被正确考虑
 * （例如 1 日元 = 0.047 人民币，不能当成 1 分）。
 *
 * @returns 换算后的整数最小单位；任一币种缺汇率时返回 null。
 */
export function convert(
  amountMinor: number,
  from: string,
  to: string,
  rates: RatesInput,
): number | null {
  if (!Number.isInteger(amountMinor)) {
    throw new TypeError(`convert: 金额必须是整数最小单位，收到 ${amountMinor}`);
  }
  const fromCode = normalizeCurrency(from);
  const toCode = normalizeCurrency(to);

  if (fromCode === toCode) return amountMinor;

  const rateFrom = rateToUsd(fromCode, rates);
  const rateTo = rateToUsd(toCode, rates);
  if (rateFrom === null || rateTo === null) return null;

  const expFrom = currencyExponent(fromCode);
  const expTo = currencyExponent(toCode);

  // minor_to = amountMinor * rateTo * 10^expTo / (rateFrom * 10^expFrom)
  //          = amountMinor * (rt.n/rt.d) * (rf.d/rf.n) * 10^expTo / 10^expFrom
  const numerator =
    BigInt(amountMinor) * rateTo.n * rateFrom.d * 10n ** BigInt(expTo);
  const denominator =
    rateTo.d * rateFrom.n * 10n ** BigInt(expFrom);

  const result = divideRoundHalfAwayFromZero(numerator, denominator);

  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('convert: 换算结果超出安全整数范围');
  }
  return Number(result);
}

/**
 * 把「原币金额 + 冻结汇率」还原成基准币种金额。
 *
 * 用于 charges：已经发生的扣款必须用扣款当天的汇率换算并冻结，
 * 而不是每次都用最新汇率重算。
 *
 * @param fxRateToBase 1 单位 currency 等于多少单位 baseCurrency（字符串）
 */
export function convertWithFrozenRate(
  amountMinor: number,
  currency: string,
  baseCurrency: string,
  fxRateToBase: string,
): number | null {
  if (!Number.isInteger(amountMinor)) {
    throw new TypeError(`convertWithFrozenRate: 金额必须是整数最小单位，收到 ${amountMinor}`);
  }
  const fromCode = normalizeCurrency(currency);
  const toCode = normalizeCurrency(baseCurrency);
  if (fromCode === toCode) return amountMinor;

  const rate = parseDecimalToRational(fxRateToBase);
  if (rate === null || rate.n <= 0n) return null;

  const expFrom = currencyExponent(fromCode);
  const expTo = currencyExponent(toCode);

  // minor_to = amountMinor / 10^expFrom * rate * 10^expTo
  const numerator = BigInt(amountMinor) * rate.n * 10n ** BigInt(expTo);
  const denominator = rate.d * 10n ** BigInt(expFrom);
  const result = divideRoundHalfAwayFromZero(numerator, denominator);

  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('convertWithFrozenRate: 换算结果超出安全整数范围');
  }
  return Number(result);
}

/**
 * 计算 1 单位 from 等于多少单位 to，用字符串返回（用于写 charges.fx_rate_to_base）。
 * 缺汇率返回 null。
 */
export function frozenRateBetween(
  from: string,
  to: string,
  rates: RatesInput,
): string | null {
  const fromCode = normalizeCurrency(from);
  const toCode = normalizeCurrency(to);
  if (fromCode === toCode) return '1';
  const rateFrom = rateToUsd(fromCode, rates);
  const rateTo = rateToUsd(toCode, rates);
  if (rateFrom === null || rateTo === null) return null;

  // 1 from(major) = 1/rateFrom USD = rateTo/rateFrom to(major)
  // 用定点字符串表示，保留 12 位有效小数，去掉尾随 0。
  const SCALE = 10n ** 12n;
  const scaled = divideRoundHalfAwayFromZero(rateTo.n * rateFrom.d * SCALE, rateTo.d * rateFrom.n);
  return fromScaledDecimal(scaled, 12);
}

/** 把「放大了 scale 位的整数」还原成十进制字符串，去掉多余的尾随 0。 */
function fromScaledDecimal(scaled: bigint, scale: number): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const digits = abs.toString().padStart(scale + 1, '0');
  const cut = digits.length - scale;
  let intPart = digits.slice(0, cut);
  let fracPart = digits.slice(cut).replace(/0+$/, '');
  if (intPart === '') intPart = '0';
  const sign = negative ? '-' : '';
  return fracPart.length > 0 ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
}
