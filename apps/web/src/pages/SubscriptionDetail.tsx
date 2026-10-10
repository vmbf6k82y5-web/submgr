import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { todayInTimeZone } from '@submgr/core';
import {
  Badge,
  Card,
  ErrorBlock,
  Field,
  LoadingBlock,
  NoticeBanner,
  SectionTitle,
  Select,
  Stack,
  StatCard,
  TextInput,
} from '../components/ui';
import { useAction, useApi } from '../hooks/useApi';
import { apiDelete, apiPost } from '../lib/api';
import {
  chargeSourceLabel,
  chargeStatusLabel,
  formatDate,
  formatInstant,
  formatMoney,
  inputToMinor,
  relativeDays,
  renewModeLabel,
  statusLabel,
  statusTone,
} from '../lib/format';
import type { ChargeDto, SettingsDto, SubscriptionDetailResponse, SubscriptionVersionRow } from '../lib/types';
import { describeCycle } from '../lib/versioning';

/** 订阅详情：基本信息 + 版本历史 + 扣款记录（+ 手动记一笔）。 */
export function SubscriptionDetail(): JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const query = useApi<SubscriptionDetailResponse>(id ? `/api/subscriptions/${id}` : null);
  const settingsQuery = useApi<{ item: SettingsDto }>('/api/settings');
  const deleteAction = useAction();
  const chargeAction = useAction();

  const settings = settingsQuery.data?.item ?? null;
  const today = settings ? todayInTimeZone(settings.timezone) : new Date().toISOString().slice(0, 10);

  const [showChargeForm, setShowChargeForm] = useState(false);
  const [chargeDate, setChargeDate] = useState(today);
  const [chargeAmount, setChargeAmount] = useState('');
  const [chargeCurrency, setChargeCurrency] = useState('');
  const [chargeStatus, setChargeStatus] = useState<'paid' | 'failed' | 'refunded'>('paid');
  const [chargeFlash, setChargeFlash] = useState<string | null>(null);

  if (query.loading && !query.data) return <LoadingBlock />;
  if (query.error) return <ErrorBlock message={query.error} onRetry={query.reload} />;
  if (!query.data) return <ErrorBlock message="没有拿到订阅详情" onRetry={query.reload} />;

  const { item, versions, charges } = query.data;
  const anomaly = item.status === 'anomaly';
  const defaultCurrency = item.current_version?.currency ?? settings?.base_currency ?? 'CNY';

  const onDelete = async (): Promise<void> => {
    if (!window.confirm(`确定删除「${item.name}」吗？版本与提醒规则会一起软删除。`)) return;
    const result = await deleteAction.run(() => apiDelete<{ deleted: boolean }>(`/api/subscriptions/${id}`));
    if (result) navigate('/subscriptions', { replace: true });
  };

  const submitCharge = async (): Promise<void> => {
    const currency = (chargeCurrency || defaultCurrency).toUpperCase();
    const amount = inputToMinor(chargeAmount, currency);
    if (!amount.ok) {
      chargeAction.setError(amount.error);
      return;
    }
    setChargeFlash(null);
    const result = await chargeAction.run(() =>
      apiPost<{ item: ChargeDto; fx_warning: string | null }>('/api/charges', {
        subscription_id: item.id,
        charge_date: chargeDate,
        amount_minor: amount.value,
        currency,
        status: chargeStatus,
        version_id: item.current_version?.id ?? null,
      }),
    );
    if (result) {
      setChargeAmount('');
      setChargeFlash(result.data.fx_warning ?? '已记账。');
      query.reload();
    }
  };

  return (
    <Stack>
      <div className="flex items-center justify-between gap-2">
        <button type="button" className="btn-secondary" onClick={() => navigate('/subscriptions')}>
          ← 列表
        </button>
        <div className="flex gap-2">
          <Link className="btn-secondary" to={`/subscriptions/${id}/edit`}>
            编辑
          </Link>
          <button type="button" className="btn-danger" onClick={onDelete} disabled={deleteAction.pending}>
            {deleteAction.pending ? '删除中…' : '删除'}
          </button>
        </div>
      </div>

      {deleteAction.error ? <ErrorBlock message={deleteAction.error} /> : null}

      <Card>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className={`truncate text-lg font-semibold ${anomaly ? 'text-red-600' : 'text-slate-900'}`}>
              {item.name}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
              {item.category_name ? <span>{item.category_name}</span> : <span>未分类</span>}
              <span>·</span>
              <span>{item.sub_type_label}</span>
              <span>·</span>
              <span>{item.charge_channel_label}</span>
              <span>·</span>
              <span>{renewModeLabel(item.renew_mode)}</span>
            </div>
          </div>
          <Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge>
        </div>

        {item.reason ? (
          <p className={`mt-2 text-sm ${anomaly ? 'font-medium text-red-600' : 'text-slate-500'}`}>
            {item.reason}
          </p>
        ) : null}

        <div className="mt-3 grid grid-cols-2 gap-2">
          <StatCard label="月均（基准币种）" value={formatMoney(item.monthly_amount_minor, settings?.base_currency ?? 'CNY')} />
          <StatCard
            label="下次到期"
            value={item.next_due_date ? formatDate(item.next_due_date) : '—'}
            hint={item.next_due_date ? relativeDays(item.next_due_date, today) : undefined}
          />
        </div>

        <div className="mt-3 space-y-1 text-sm text-slate-600">
          <p>开始日期：{formatDate(item.start_date)}</p>
          {item.end_date ? <p>结束日期：{formatDate(item.end_date)}</p> : null}
          {item.note ? <p className="whitespace-pre-wrap">备注：{item.note}</p> : null}
        </div>
      </Card>

      <Card>
        <SectionTitle>版本历史（{versions.length}）</SectionTitle>
        <ul className="divide-y divide-slate-100">
          {[...versions].reverse().map((version) => (
            <VersionRow key={version.id} version={version} today={today} />
          ))}
          {versions.length === 0 ? <li className="py-3 text-sm text-slate-400">还没有价格版本</li> : null}
        </ul>
        <p className="mt-2 text-xs text-slate-500">
          已生效的版本金额/币种/周期被冻结，不能修改也不能删除；调价请在「编辑」页新增一个版本。
        </p>
      </Card>

      <Card>
        <SectionTitle
          action={
            <button type="button" className="btn-secondary" onClick={() => setShowChargeForm((v) => !v)}>
              {showChargeForm ? '收起' : '＋ 记一笔'}
            </button>
          }
        >
          扣款记录（{charges.length}）
        </SectionTitle>

        {chargeFlash ? (
          <div className="mb-2">
            <NoticeBanner level="info" title={chargeFlash} />
          </div>
        ) : null}

        {showChargeForm ? (
          <div className="mb-3 space-y-3 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
            <div className="grid grid-cols-2 gap-2">
              <Field label="扣款日">
                <TextInput type="date" value={chargeDate} onChange={(event) => setChargeDate(event.target.value)} />
              </Field>
              <Field label="币种">
                <TextInput
                  value={chargeCurrency || defaultCurrency}
                  maxLength={3}
                  onChange={(event) => setChargeCurrency(event.target.value.toUpperCase())}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="金额（主单位）">
                <TextInput
                  inputMode="decimal"
                  placeholder="25.00"
                  value={chargeAmount}
                  onChange={(event) => setChargeAmount(event.target.value)}
                />
              </Field>
              <Field label="状态">
                <Select
                  value={chargeStatus}
                  onChange={(event) => setChargeStatus(event.target.value as typeof chargeStatus)}
                >
                  <option value="paid">已支付</option>
                  <option value="failed">扣款失败</option>
                  <option value="refunded">已退款</option>
                </Select>
              </Field>
            </div>
            {chargeAction.error ? <p className="text-sm text-red-600">{chargeAction.error}</p> : null}
            <button type="button" className="btn-primary w-full" onClick={submitCharge} disabled={chargeAction.pending}>
              {chargeAction.pending ? '保存中…' : '保存扣款记录'}
            </button>
            <p className="text-xs text-slate-500">
              手动记账的汇率会按扣款当天冻结；缺汇率时基准金额留空并给出提示，不会记成 0。
            </p>
          </div>
        ) : null}

        <ul className="divide-y divide-slate-100">
          {charges.map((charge) => (
            <li key={charge.id} className="flex items-start justify-between gap-3 py-2">
              <div>
                <p className="tabular text-sm text-slate-800">
                  {formatMoney(charge.amount_minor, charge.currency)}
                  {charge.base_amount_minor !== null && charge.base_currency !== null ? (
                    <span className="text-slate-400">
                      {' '}
                      ≈ {formatMoney(charge.base_amount_minor, charge.base_currency)}
                    </span>
                  ) : (
                    <span className="text-amber-600"> · 缺汇率，基准金额未冻结</span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {formatDate(charge.charge_date)} · {chargeSourceLabel(charge.source)}
                  {charge.fx_rate_to_base && charge.currency !== charge.base_currency
                    ? ` · 冻结汇率 ${charge.fx_rate_to_base}`
                    : ''}
                </p>
              </div>
              <Badge tone={charge.status === 'paid' ? 'ok' : charge.status === 'failed' ? 'danger' : 'warn'}>
                {chargeStatusLabel(charge.status)}
              </Badge>
            </li>
          ))}
          {charges.length === 0 ? <li className="py-3 text-sm text-slate-400">还没有扣款记录</li> : null}
        </ul>
      </Card>
    </Stack>
  );
}

function VersionRow({ version, today }: { version: SubscriptionVersionRow; today: string }): JSX.Element {
  const frozen = version.effective_from <= today;
  const isTrial = version.is_trial === 1 || version.is_trial === true;
  return (
    <li className="py-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="tabular text-sm text-slate-800">
            {formatMoney(version.amount_minor, version.currency)} / {describeCycle(version.cycle_type, version.cycle_days)}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            生效日 {formatDate(version.effective_from)}
            {version.plan_name ? ` · ${version.plan_name}` : ''}
          </p>
          {isTrial ? (
            <p className="mt-0.5 text-xs text-amber-600">
              试用，{version.trial_end_date ? `${formatDate(version.trial_end_date)} 结束` : '未设置结束日'}
              {version.after_trial_amount_minor !== null && version.after_trial_currency
                ? `，转正后 ${formatMoney(version.after_trial_amount_minor, version.after_trial_currency)}`
                : '，试用后不续费'}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge tone={frozen ? 'muted' : 'info'}>{frozen ? '已生效 · 冻结' : '未生效'}</Badge>
          <span className="text-[11px] text-slate-400">{formatInstant(version.created_at)}</span>
        </div>
      </div>
    </li>
  );
}
