/**
 * 把 /api/trends 的结果转成 ECharts 配置（纯函数，可单测）。
 *
 * 两个必须守住的口径：
 *   1) 缺汇率的格子是 null（不是 0）——图上留空，绝不画成 0；
 *   2) 柱子顺序 = 后端给的 groups 顺序（按区间总额从大到小），前端不再排序。
 */

import { currencyExponent, type TrendCell, type TrendGroup, type TrendResult } from '@submgr/core';
import type { EChartsOption } from 'echarts';
import { formatMonthAxis } from './format';

/** 默认调色板（与 Tailwind 色板同源，保证风格统一）。 */
export const TREND_PALETTE = [
  '#0ea5e9',
  '#f97316',
  '#22c55e',
  '#a855f7',
  '#ef4444',
  '#eab308',
  '#14b8a6',
  '#6366f1',
  '#ec4899',
  '#84cc16',
];

export interface TrendChartOptions {
  /** X 轴同年只显示「3月」，跨年显示「25年3月」 */
  currentYear: number;
  /** 分组 key -> 颜色（分类维度直接用分类色） */
  colorMap?: Record<string, string>;
}

/** 金额从最小单位换成主单位（展示用，只在这里接触浮点）。 */
export function toMajor(amountMinor: number, currency: string): number {
  return amountMinor / 10 ** currencyExponent(currency);
}

export function buildStackedBarOption(
  result: Pick<TrendResult, 'months' | 'groups' | 'cells' | 'baseCurrency'>,
  options: TrendChartOptions,
): EChartsOption {
  const perMajor = 10 ** currencyExponent(result.baseCurrency);
  const cellMap = new Map<string, TrendCell>();
  for (const cell of result.cells) cellMap.set(`${cell.month}|${cell.group}`, cell);

  const series = result.groups.map((group: TrendGroup, index: number) => ({
    name: group.label,
    type: 'bar' as const,
    stack: 'total',
    barMaxWidth: 28,
    emphasis: { focus: 'series' as const },
    itemStyle: {
      color: options.colorMap?.[group.key] ?? TREND_PALETTE[index % TREND_PALETTE.length],
    },
    // null 就是「缺汇率算不出来」，ECharts 会留空，不会显示成 0
    data: result.months.map((month) => {
      const cell = cellMap.get(`${month}|${group.key}`);
      if (!cell || cell.amountBaseMinor === null) return null;
      return Number((cell.amountBaseMinor / perMajor).toFixed(2));
    }),
  }));

  return {
    grid: { left: 4, right: 8, top: 16, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      valueFormatter: (value) =>
        typeof value === 'number' ? `${result.baseCurrency} ${value.toFixed(2)}` : '缺汇率',
    },
    legend: {
      type: 'scroll',
      bottom: 0,
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { fontSize: 11, color: '#475569' },
    },
    xAxis: {
      type: 'category',
      data: result.months.map((month) => formatMonthAxis(month, options.currentYear)),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#cbd5e1' } },
      axisLabel: { fontSize: 11, color: '#475569' },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: '#e2e8f0' } },
      axisLabel: {
        fontSize: 11,
        color: '#475569',
        formatter: (value: number) => `${result.baseCurrency} ${value}`,
      },
    },
    series,
  };
}
