/**
 * @submgr/core —— 订阅管家核心领域逻辑
 *
 * 纯函数，零 Cloudflare 依赖，Worker（Hono）与前端（React PWA）共用同一套规则。
 *
 * 模块划分：
 *   types    领域类型（与 D1 列一一对应）+ 枚举
 *   time     日期 / 时间点 / 用户时区工具
 *   money    ISO 4217 小数位、整数金额、BigInt 精确换算
 *   cycles   周期与到期日（锚点日、闰年、固定天数、终身）
 *   amounts  月均 / 年均折算
 *   status   active / ended / anomaly 判定
 *   fx       汇率快照健康度（stale、缺币种）
 *   summary  总览汇总
 *   trend    按月堆叠趋势（/api/trends）+ 中文字段标签
 */

export * from './types.js';
export * from './time.js';
export * from './money.js';
export * from './cycles.js';
export * from './amounts.js';
export * from './status.js';
export * from './fx.js';
export * from './summary.js';
export * from './trend.js';
