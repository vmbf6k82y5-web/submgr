import { describe, expect, it } from 'vitest';
import { TREND_PALETTE, buildStackedBarOption, toMajor } from './trendOption';

const RESULT = {
  baseCurrency: 'CNY',
  months: ['2026-01', '2026-02', '2026-03'],
  groups: [
    { key: 'cat-media', label: '影音娱乐' },
    { key: 'cat-cloud', label: '云服务' },
  ],
  cells: [
    { month: '2026-01', group: 'cat-media', amountBaseMinor: 2500, chargeCount: 1 },
    { month: '2026-01', group: 'cat-cloud', amountBaseMinor: 6800, chargeCount: 1 },
    { month: '2026-02', group: 'cat-media', amountBaseMinor: 3000, chargeCount: 1 },
    // 缺汇率：null（不是 0）
    { month: '2026-02', group: 'cat-cloud', amountBaseMinor: null, chargeCount: 1 },
    { month: '2026-03', group: 'cat-media', amountBaseMinor: 3000, chargeCount: 1 },
    { month: '2026-03', group: 'cat-cloud', amountBaseMinor: 6800, chargeCount: 1 },
  ],
};

interface SeriesLike {
  name: string;
  type: string;
  stack?: string;
  data: (number | null)[];
  itemStyle?: { color?: string };
}

describe('trendOption: 堆叠柱状图配置', () => {
  it('每个分组一条 series，长度与月份一致，顺序沿用后端排序', () => {
    const option = buildStackedBarOption(RESULT, { currentYear: 2026 });
    const series = option.series as unknown as SeriesLike[];
    expect(series).toHaveLength(2);
    expect(series.map((s) => s.name)).toEqual(['影音娱乐', '云服务']);
    expect(series.every((s) => s.type === 'bar' && s.stack === 'total')).toBe(true);
    expect(series.every((s) => s.data.length === 3)).toBe(true);
  });

  it('缺汇率的格子是 null，不会被画成 0', () => {
    const option = buildStackedBarOption(RESULT, { currentYear: 2026 });
    const series = option.series as unknown as SeriesLike[];
    expect(series[1]?.data).toEqual([68, null, 68]);
    expect(series[0]?.data).toEqual([25, 30, 30]);
  });

  it('金额按币种小数位换成主单位', () => {
    expect(toMajor(2500, 'CNY')).toBe(25);
    expect(toMajor(1200, 'JPY')).toBe(1200);
    expect(toMajor(-1680, 'CNY')).toBe(-16.8);
  });

  it('分类颜色映射生效，否则用默认调色板', () => {
    const mapped = buildStackedBarOption(RESULT, {
      currentYear: 2026,
      colorMap: { 'cat-media': '#ef4444' },
    });
    const series = mapped.series as unknown as SeriesLike[];
    expect(series[0]?.itemStyle?.color).toBe('#ef4444');
    expect(series[1]?.itemStyle?.color).toBe(TREND_PALETTE[1]);
  });

  it('X 轴标签：当年用「3月」，跨年补年份', () => {
    const option = buildStackedBarOption(RESULT, { currentYear: 2026 });
    const xAxis = option.xAxis as unknown as { data: string[] };
    expect(xAxis.data).toEqual(['1月', '2月', '3月']);

    const crossYear = buildStackedBarOption(
      { ...RESULT, months: ['2025-12', '2026-01'] },
      { currentYear: 2026 },
    );
    const crossAxis = crossYear.xAxis as unknown as { data: string[] };
    expect(crossAxis.data).toEqual(['25年12月', '1月']);
  });

  it('没有分组时也返回合法配置（不抛错）', () => {
    const option = buildStackedBarOption({ ...RESULT, groups: [], cells: [] }, { currentYear: 2026 });
    expect((option.series as unknown as SeriesLike[]).length).toBe(0);
  });
});
