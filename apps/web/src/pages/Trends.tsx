import { useMemo, useState } from 'react';
import {
  TREND_DIMENSIONS,
  TREND_DIMENSION_LABELS,
  addMonthsToMonthKey,
  monthKeyOf,
  todayInTimeZone,
  type TrendDimension,
} from '@submgr/core';
import { EChart } from '../components/EChart';
import {
  Card,
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  NoticeBanner,
  SectionTitle,
  Stack,
  StatCard,
} from '../components/ui';
import { useApi } from '../hooks/useApi';
import { formatMoney } from '../lib/format';
import { buildStackedBarOption } from '../lib/trendOption';
import type { CategoryDto, SettingsDto, TrendsResponse } from '../lib/types';

const RANGE_OPTIONS = [
  { months: 6, label: '近 6 个月' },
  { months: 12, label: '近 12 个月' },
  { months: 24, label: '近 24 个月' },
];

/**
 * 趋势：按月堆叠柱状图，可切换四个分组维度。
 * 分桶完全由后端（core 的 monthlyTrend）完成，前端只负责画。
 */
export function Trends(): JSX.Element {
  const [dimension, setDimension] = useState<TrendDimension>('category');
  const [months, setMonths] = useState(12);

  const settingsQuery = useApi<{ item: SettingsDto }>('/api/settings');
  const categoriesQuery = useApi<{ items: CategoryDto[] }>('/api/categories');

  const settings = settingsQuery.data?.item ?? null;
  const today = settings ? todayInTimeZone(settings.timezone) : new Date().toISOString().slice(0, 10);
  const to = monthKeyOf(today);
  const from = addMonthsToMonthKey(to, -(months - 1));

  const query = useApi<TrendsResponse>('/api/trends', {
    query: { group: dimension, from, to },
  });

  const result = query.data?.item ?? null;
  const baseCurrency = result?.baseCurrency ?? settings?.base_currency ?? 'CNY';

  const colorMap = useMemo(() => {
    if (dimension !== 'category') return {};
    const map: Record<string, string> = {};
    for (const category of categoriesQuery.data?.items ?? []) map[category.id] = category.color;
    return map;
  }, [dimension, categoriesQuery.data]);

  const option = useMemo(() => {
    if (!result) return null;
    return buildStackedBarOption(result, { currentYear: Number(to.slice(0, 4)), colorMap });
  }, [result, to, colorMap]);

  return (
    <Stack>
      <div>
        <h2 className="text-base font-semibold text-slate-900">支出趋势</h2>
        <p className="text-xs text-slate-500">
          {from} ~ {to} · 只统计实际发生的扣款（失败排除、退款记负数）
        </p>
      </div>

      <div className="flex gap-1 rounded-xl bg-slate-200/70 p-1">
        {TREND_DIMENSIONS.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setDimension(value)}
            className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition ${
              dimension === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
            }`}
          >
            {TREND_DIMENSION_LABELS[value]}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        {RANGE_OPTIONS.map((range) => (
          <button
            key={range.months}
            type="button"
            onClick={() => setMonths(range.months)}
            className={`flex-1 rounded-xl px-2 py-1.5 text-xs transition ${
              months === range.months
                ? 'bg-slate-900 text-white'
                : 'bg-white text-slate-600 ring-1 ring-slate-200'
            }`}
          >
            {range.label}
          </button>
        ))}
      </div>

      {result && result.missingCurrencies.length > 0 ? (
        <NoticeBanner
          level="danger"
          title={`缺少 ${result.missingCurrencies.join('、')} 的汇率`}
          detail="对应月份的柱子会留空（不是 0），补齐汇率后会自动恢复。"
        />
      ) : null}

      {query.loading && !result ? <LoadingBlock /> : null}
      {query.error ? <ErrorBlock message={query.error} onRetry={query.reload} /> : null}

      {result && result.groups.length === 0 ? (
        <EmptyBlock title="这段时间没有扣款记录" detail="换个区间，或先在订阅详情里记几笔扣款" />
      ) : null}

      {result && option && result.groups.length > 0 ? (
        <>
          <Card>
            <EChart option={option} height={340} ariaLabel="月度支出堆叠柱状图" />
          </Card>

          <div className="grid grid-cols-2 gap-2">
            <StatCard
              label="区间合计"
              value={formatMoney(result.grandTotalMinor, baseCurrency)}
              tone={result.grandTotalMinor === null ? 'danger' : 'default'}
              hint={result.grandTotalMinor === null ? '有月份缺汇率' : undefined}
            />
            <StatCard
              label="分组数量"
              value={`${result.groups.length} 组`}
              hint={`${result.months.length} 个月`}
            />
          </div>

          <Card>
            <SectionTitle>口径说明</SectionTitle>
            <ul className="space-y-1 text-xs text-slate-500">
              <li>· 币种：优先用扣款当天冻结的基准金额，否则按最新汇率折算。</li>
              <li>· 退款按负数计入，扣款失败完全排除（失败 {result.excluded.failed} 笔、退款 {result.excluded.refunded} 笔）。</li>
              <li>· 找不到订阅的孤儿扣款 {result.excluded.orphan} 笔，未计入分组。</li>
              <li>· 分组按区间总额从大到小排序。</li>
            </ul>
          </Card>
        </>
      ) : null}
    </Stack>
  );
}
