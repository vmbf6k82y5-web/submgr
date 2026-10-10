import { Link } from 'react-router-dom';
import { Badge, Card, ErrorBlock, LoadingBlock, NoticeBanner, SectionTitle, Stack, StatCard } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { formatInstant, formatMoney, fxNotices, statusLabel, statusTone } from '../lib/format';
import type { SummaryDto } from '../lib/types';

/**
 * 总览：三种状态分开统计 + 月均/年均/未来 30 天 + 汇率健康度提示。
 * 数字全部来自 /api/summary（core 的 summarize），前端不做任何加减。
 */
export function Overview(): JSX.Element {
  const query = useApi<{ item: SummaryDto }>('/api/summary');
  const summary = query.data?.item ?? null;

  if (query.loading && !summary) return <LoadingBlock />;
  if (query.error) return <ErrorBlock message={query.error} onRetry={query.reload} />;
  if (!summary) return <ErrorBlock message="没有拿到汇总数据" onRetry={query.reload} />;

  const currency = summary.baseCurrency;
  const notices = fxNotices(summary);
  const statusOrder: ('active' | 'anomaly' | 'ended')[] = ['active', 'anomaly', 'ended'];

  return (
    <Stack>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">这个月花了多少</h2>
          <p className="text-xs text-slate-500">
            基准币种 {currency} · 时区 {summary.timezone} · 统计日 {summary.today}
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={query.reload} disabled={query.loading}>
          刷新
        </button>
      </div>

      {notices.map((notice) => (
        <NoticeBanner key={notice.title} level={notice.level} title={notice.title} detail={notice.detail} />
      ))}

      <div className="grid grid-cols-3 gap-2">
        <StatCard
          label="月均支出"
          value={formatMoney(summary.monthlyAverageMinor, currency)}
          hint={summary.monthlyAverageMinor === null ? '缺汇率，无法合计' : '正常 + 异常订阅'}
          tone={summary.monthlyAverageMinor === null ? 'danger' : 'default'}
        />
        <StatCard
          label="年均支出"
          value={formatMoney(summary.yearlyAverageMinor, currency)}
          hint={summary.yearlyAverageMinor === null ? '缺汇率，无法合计' : '由周期直接算出'}
          tone={summary.yearlyAverageMinor === null ? 'danger' : 'default'}
        />
        <StatCard
          label={`未来 ${summary.window_days} 天`}
          value={formatMoney(summary.next30DaysMinor, currency)}
          hint={summary.next30DaysMinor === null ? '缺汇率，无法合计' : '将扣的金额'}
          tone={summary.next30DaysMinor === null ? 'danger' : 'default'}
        />
      </div>

      <div>
        <SectionTitle>三种状态分开统计</SectionTitle>
        <div className="space-y-3">
          {statusOrder.map((status) => {
            const entries = summary.byStatus[status] ?? [];
            const tone = statusTone(status);
            return (
              <Card key={status}>
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge tone={tone}>{statusLabel(status)}</Badge>
                    <span className="tabular text-sm text-slate-500">{entries.length} 个订阅</span>
                  </div>
                </div>
                {entries.length === 0 ? (
                  <p className="text-sm text-slate-400">没有{statusLabel(status)}的订阅</p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {entries.map((entry) => (
                      <li key={entry.subscriptionId} className="py-2 last:pb-0">
                        <Link
                          to={`/subscriptions/${entry.subscriptionId}`}
                          className="flex items-start justify-between gap-3"
                        >
                          <span className={status === 'anomaly' ? 'font-medium text-red-600' : 'text-slate-800'}>
                            {entry.name}
                          </span>
                          <span
                            className={`shrink-0 text-right text-xs ${
                              status === 'anomaly' ? 'text-red-500' : 'text-slate-400'
                            }`}
                          >
                            {entry.reason}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            );
          })}
        </div>
      </div>

      <Card className="text-xs text-slate-500">
        <p>
          汇总口径：月均/年均只统计「正常 + 异常」的订阅（已结束的不再计入），
          未来 {summary.window_days} 天是左开右闭区间（今天已扣的不重复计）。
        </p>
        <p className="mt-1">
          汇率快照：{summary.fxAsOf ? `${formatInstant(summary.fxAsOf, summary.timezone)}（${summary.timezone}）` : '暂无'}
          {summary.stale ? ' · 已过期' : ''}
          {summary.missingCurrencies.length > 0 ? ` · 缺少：${summary.missingCurrencies.join('、')}` : ''}
        </p>
        <p className="mt-1">生成时间：{formatInstant(summary.generated_at, summary.timezone)}</p>
      </Card>
    </Stack>
  );
}
