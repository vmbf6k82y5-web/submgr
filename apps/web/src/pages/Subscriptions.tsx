import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, Card, EmptyBlock, ErrorBlock, LoadingBlock, Select, Stack, TextInput } from '../components/ui';
import { useApi } from '../hooks/useApi';
import {
  formatDateShort,
  formatMoney,
  relativeDays,
  renewModeLabel,
  statusLabel,
  statusTone,
} from '../lib/format';
import type { CategoryDto, SubscriptionDto, SubscriptionListResponse } from '../lib/types';

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'active', label: '正常' },
  { value: 'anomaly', label: '异常' },
  { value: 'ended', label: '已结束' },
];

/** 订阅列表：搜索 + 状态/分类过滤 + 异常标红。 */
export function Subscriptions(): JSX.Element {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [categoryId, setCategoryId] = useState('');
  // 输入防抖：不要在每次按键都打接口
  const [debouncedQ, setDebouncedQ] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [q]);

  const query = useApi<SubscriptionListResponse>('/api/subscriptions', {
    query: { status: status || undefined, q: debouncedQ || undefined, category_id: categoryId || undefined },
  });
  const categories = useApi<{ items: CategoryDto[] }>('/api/categories');

  const items = useMemo(() => query.data?.items ?? [], [query.data]);
  const counts = query.data?.counts;
  const baseCurrency = query.data?.base_currency ?? 'CNY';
  const today = query.data?.today ?? '';

  return (
    <Stack>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">订阅列表</h2>
          <p className="text-xs text-slate-500">
            {counts
              ? `共 ${counts.total} 个 · 正常 ${counts.active} · 异常 ${counts.anomaly} · 已结束 ${counts.ended}`
              : '加载中…'}
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => navigate('/subscriptions/new')}>
          ＋ 新增
        </button>
      </div>

      <div className="space-y-2">
        <TextInput
          type="search"
          placeholder="搜索订阅名称"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          aria-label="搜索订阅名称"
        />
        <div className="flex gap-2">
          <Select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            aria-label="按状态筛选"
          >
            {STATUS_FILTERS.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </Select>
          <Select
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
            aria-label="按分类筛选"
          >
            <option value="">全部分类</option>
            {(categories.data?.items ?? []).map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {query.loading && items.length === 0 ? <LoadingBlock /> : null}
      {query.error ? <ErrorBlock message={query.error} onRetry={query.reload} /> : null}

      {!query.error && !query.loading && items.length === 0 ? (
        <EmptyBlock
          title="没有匹配的订阅"
          detail={debouncedQ || status || categoryId ? '换个筛选条件试试' : '先新增一个订阅吧'}
          action={
            <button type="button" className="btn-primary" onClick={() => navigate('/subscriptions/new')}>
              ＋ 新增订阅
            </button>
          }
        />
      ) : null}

      <ul className="space-y-2">
        {items.map((item) => (
          <SubscriptionRow key={item.id} item={item} baseCurrency={baseCurrency} today={today} />
        ))}
      </ul>
    </Stack>
  );
}

function SubscriptionRow({
  item,
  baseCurrency,
  today,
}: {
  item: SubscriptionDto;
  baseCurrency: string;
  today: string;
}): JSX.Element {
  const anomaly = item.status === 'anomaly';
  const ended = item.status === 'ended';
  return (
    <li>
      <Link
        to={`/subscriptions/${item.id}`}
        className={`card block border-l-4 p-3 transition active:bg-slate-50 ${
          anomaly ? 'border-l-red-500' : ended ? 'border-l-slate-300' : 'border-l-emerald-500'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className={`truncate font-medium ${anomaly ? 'text-red-600' : 'text-slate-900'}`}>
              {item.name}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
              {item.category_name ? (
                <span className="inline-flex items-center gap-1">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: item.category_color ?? '#94a3b8' }}
                  />
                  {item.category_name}
                </span>
              ) : null}
              <span>·</span>
              <span>{item.sub_type_label}</span>
              <span>·</span>
              <span>{item.charge_channel_label}</span>
              <span>·</span>
              <span>{renewModeLabel(item.renew_mode)}</span>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <p className={`tabular font-semibold ${anomaly ? 'text-red-600' : 'text-slate-900'}`}>
              {formatMoney(item.monthly_amount_minor, baseCurrency)}
            </p>
            <p className="text-xs text-slate-400">每月</p>
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between gap-2">
          <Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge>
          <span className={`text-xs ${anomaly ? 'text-red-500' : 'text-slate-500'}`}>
            {item.next_due_date
              ? `下次 ${formatDateShort(item.next_due_date, today)}（${relativeDays(item.next_due_date, today)}）`
              : item.reason || '无到期日'}
          </span>
        </div>
        {anomaly && item.reason ? (
          <p className="mt-1 text-xs font-medium text-red-500">{item.reason}</p>
        ) : null}
      </Link>
    </li>
  );
}
