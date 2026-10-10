import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  CHARGE_CHANNELS,
  RENEW_MODES,
  SUB_TYPES,
  chargeChannelLabel,
  subTypeLabel,
  todayInTimeZone,
  type ChargeChannel,
  type RenewMode,
  type SubType,
} from '@submgr/core';
import { VersionFields } from '../components/VersionFields';
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
  TextArea,
  TextInput,
} from '../components/ui';
import { useAction, useApi } from '../hooks/useApi';
import { apiPatch, apiPost } from '../lib/api';
import { formatDate, formatMoney, inputToMinor, minorToInput, renewModeLabel } from '../lib/format';
import type {
  CategoryDto,
  SettingsDto,
  SubscriptionDetailResponse,
  SubscriptionDto,
  SubscriptionInput,
} from '../lib/types';
import {
  describeCycle,
  emptyVersionDraft,
  hasVersionOn,
  newVersionHint,
  validateVersionDraft,
  type PriceDraft,
  type VersionDraft,
} from '../lib/versioning';

interface BasicDraft {
  name: string;
  categoryId: string;
  subType: SubType;
  chargeChannel: ChargeChannel;
  renewMode: RenewMode;
  startDate: string;
  endDate: string;
  note: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayOf(settings: SettingsDto | null): string {
  if (settings) return todayInTimeZone(settings.timezone);
  return new Date().toISOString().slice(0, 10);
}

/**
 * 新增 / 编辑订阅。
 *
 * 关键规则（需求点名）：**改价格不能直接改已生效版本**。
 *   * 新增：基本信息和「首个价格版本」一起提交（POST /api/subscriptions）；
 *   * 编辑：基本信息走 PATCH；价格另开一块，保存时走
 *     POST /api/subscriptions/:id/versions（只新增版本，历史金额不动）。
 */
export function SubscriptionForm({ mode }: { mode: 'create' | 'edit' }): JSX.Element {
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const id = params.id ?? '';
  const isEdit = mode === 'edit';

  const settingsQuery = useApi<{ item: SettingsDto }>('/api/settings');
  const categoriesQuery = useApi<{ items: CategoryDto[] }>('/api/categories');
  const detailQuery = useApi<SubscriptionDetailResponse>(isEdit && id ? `/api/subscriptions/${id}` : null);

  const settings = settingsQuery.data?.item ?? null;
  const detail = detailQuery.data ?? null;
  const currentVersion = detail?.item.current_version ?? null;
  const today = todayOf(settings);

  const [basic, setBasic] = useState<BasicDraft>({
    name: '',
    categoryId: '',
    subType: 'software',
    chargeChannel: 'alipay',
    renewMode: 'auto',
    startDate: today,
    endDate: '',
    note: '',
  });
  const [version, setVersion] = useState<VersionDraft>(() => emptyVersionDraft('CNY', today));
  const [priceVersion, setPriceVersion] = useState<VersionDraft>(() => emptyVersionDraft('CNY', today));
  const [basicError, setBasicError] = useState<string | null>(null);
  const [versionError, setVersionError] = useState<{ field?: keyof VersionDraft; message: string } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  const createAction = useAction();
  const updateAction = useAction();
  const versionAction = useAction();

  // 首次拿到设置/详情后填默认值（只做一次，避免覆盖用户输入）
  useEffect(() => {
    if (initialized) return;
    if (!settings) return;
    if (isEdit && !detail) return;

    if (isEdit && detail) {
      const item = detail.item;
      setBasic({
        name: item.name,
        categoryId: item.category_id ?? '',
        subType: item.sub_type,
        chargeChannel: item.charge_channel as ChargeChannel,
        renewMode: item.renew_mode,
        startDate: item.start_date,
        endDate: item.end_date ?? '',
        note: item.note ?? '',
      });
      const current = item.current_version;
      setPriceVersion({
        ...emptyVersionDraft(current?.currency ?? settings.base_currency, today),
        amount: current ? minorToInput(current.amount_minor, current.currency) : '',
        currency: current?.currency ?? settings.base_currency,
        cycleType: current?.cycle_type ?? 'month',
        cycleDays: current?.cycle_days === null || current?.cycle_days === undefined ? '' : String(current.cycle_days),
        planName: current?.plan_name ?? '',
      });
      setVersion({
        ...emptyVersionDraft(current?.currency ?? settings.base_currency, today),
        currency: current?.currency ?? settings.base_currency,
      });
    } else {
      setBasic((prev) => ({ ...prev, startDate: today }));
      setVersion(emptyVersionDraft(settings.base_currency, today));
      setPriceVersion(emptyVersionDraft(settings.base_currency, today));
    }
    setInitialized(true);
  }, [initialized, settings, detail, isEdit, today]);

  const categories = categoriesQuery.data?.items ?? [];
  const versions = detail?.versions ?? [];
  const duplicateDay = hasVersionOn(versions, priceVersion.effectiveFrom);

  // 调价提示：随输入实时变化
  const hint = useMemo(() => {
    if (!isEdit || !currentVersion) return null;
    const currency = priceVersion.currency.trim().toUpperCase();
    const parsedAmount = inputToMinor(priceVersion.amount, /^[A-Z]{3}$/.test(currency) ? currency : 'CNY');
    const draftPrice: PriceDraft = {
      amountMinor: parsedAmount.ok ? parsedAmount.value : null,
      currency,
      cycleType: priceVersion.cycleType,
      cycleDays: priceVersion.cycleType === 'days' ? Number(priceVersion.cycleDays) || null : null,
    };
    return newVersionHint(currentVersion, draftPrice, today);
  }, [isEdit, currentVersion, priceVersion, today]);

  if (settingsQuery.loading && !settings) return <LoadingBlock />;
  if (settingsQuery.error) return <ErrorBlock message={settingsQuery.error} onRetry={settingsQuery.reload} />;
  if (isEdit && detailQuery.error) {
    return <ErrorBlock message={detailQuery.error} onRetry={detailQuery.reload} />;
  }
  if (isEdit && !detail) return <LoadingBlock />;

  const validateBasic = (): SubscriptionInput | null => {
    if (basic.name.trim() === '') {
      setBasicError('订阅名称不能为空');
      return null;
    }
    if (!DATE_RE.test(basic.startDate)) {
      setBasicError('开始日期必须是 YYYY-MM-DD');
      return null;
    }
    if (basic.endDate !== '' && !DATE_RE.test(basic.endDate)) {
      setBasicError('结束日期必须是 YYYY-MM-DD');
      return null;
    }
    if (basic.endDate !== '' && basic.endDate < basic.startDate) {
      setBasicError('结束日期不能早于开始日期');
      return null;
    }
    setBasicError(null);
    return {
      name: basic.name.trim(),
      category_id: basic.categoryId === '' ? null : basic.categoryId,
      sub_type: basic.subType,
      charge_channel: basic.chargeChannel,
      renew_mode: basic.renewMode,
      start_date: basic.startDate,
      end_date: basic.endDate === '' ? null : basic.endDate,
      note: basic.note.trim() === '' ? null : basic.note.trim(),
    };
  };

  const submitCreate = async (): Promise<void> => {
    const payload = validateBasic();
    if (!payload) return;
    const parsed = validateVersionDraft(version);
    if (!parsed.ok) {
      setVersionError({ field: parsed.field, message: parsed.error });
      return;
    }
    setVersionError(null);
    const result = await createAction.run(() =>
      apiPost<{ item: SubscriptionDto; created_version_id: string | null }>('/api/subscriptions', {
        ...payload,
        version: parsed.value,
      }),
    );
    if (result) navigate(`/subscriptions/${result.data.item.id}`, { replace: true });
  };

  const submitBasicUpdate = async (): Promise<void> => {
    const payload = validateBasic();
    if (!payload) return;
    const result = await updateAction.run(() =>
      apiPatch<{ item: SubscriptionDto }>(`/api/subscriptions/${id}`, payload),
    );
    if (result) {
      setFlash('基本信息已保存。');
      detailQuery.reload();
    }
  };

  const submitNewVersion = async (): Promise<void> => {
    const parsed = validateVersionDraft(priceVersion);
    if (!parsed.ok) {
      setVersionError({ field: parsed.field, message: parsed.error });
      return;
    }
    setVersionError(null);
    const result = await versionAction.run(() =>
      apiPost<{ item: unknown; created: boolean }>(`/api/subscriptions/${id}/versions`, parsed.value),
    );
    if (result) navigate(`/subscriptions/${id}`);
  };

  return (
    <Stack>
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">{isEdit ? '编辑订阅' : '新增订阅'}</h2>
        <button type="button" className="btn-secondary" onClick={() => navigate(-1)}>
          返回
        </button>
      </div>

      {flash ? <NoticeBanner level="info" title={flash} /> : null}

      <Card>
        <SectionTitle>基本信息</SectionTitle>
        <div className="space-y-3">
          <Field label="名称" error={basicError}>
            <TextInput
              placeholder="例如：Netflix 高级会员"
              value={basic.name}
              maxLength={200}
              onChange={(event) => setBasic({ ...basic, name: event.target.value })}
            />
          </Field>

          <Field label="分类">
            <Select
              value={basic.categoryId}
              onChange={(event) => setBasic({ ...basic, categoryId: event.target.value })}
            >
              <option value="">未分类</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="订阅类型">
              <Select
                value={basic.subType}
                onChange={(event) => setBasic({ ...basic, subType: event.target.value as SubType })}
              >
                {SUB_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {subTypeLabel(value)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="扣费渠道">
              <Select
                value={basic.chargeChannel}
                onChange={(event) => setBasic({ ...basic, chargeChannel: event.target.value as ChargeChannel })}
              >
                {CHARGE_CHANNELS.map((value) => (
                  <option key={value} value={value}>
                    {chargeChannelLabel(value)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="续费方式" hint="渠道只是记录，不会跳转任何续费/取消页面">
            <Select
              value={basic.renewMode}
              onChange={(event) => setBasic({ ...basic, renewMode: event.target.value as RenewMode })}
            >
              {RENEW_MODES.map((value) => (
                <option key={value} value={value}>
                  {renewModeLabel(value)}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="开始日期">
              <TextInput
                type="date"
                value={basic.startDate}
                onChange={(event) => setBasic({ ...basic, startDate: event.target.value })}
              />
            </Field>
            <Field label="结束日期（可选）">
              <TextInput
                type="date"
                value={basic.endDate}
                onChange={(event) => setBasic({ ...basic, endDate: event.target.value })}
              />
            </Field>
          </div>

          <Field label="备注（可选）">
            <TextArea
              rows={2}
              maxLength={2000}
              value={basic.note}
              onChange={(event) => setBasic({ ...basic, note: event.target.value })}
            />
          </Field>
        </div>

        {basicError ? <p className="mt-2 text-sm text-red-600">{basicError}</p> : null}
        {updateAction.error ? <p className="mt-2 text-sm text-red-600">{updateAction.error}</p> : null}

        {isEdit ? (
          <button
            type="button"
            className="btn-primary mt-4 w-full"
            onClick={submitBasicUpdate}
            disabled={updateAction.pending}
          >
            {updateAction.pending ? '保存中…' : '保存基本信息'}
          </button>
        ) : null}
      </Card>

      {!isEdit ? (
        <Card>
          <SectionTitle>首个价格版本</SectionTitle>
          <VersionFields
            draft={version}
            onChange={(patch) => setVersion({ ...version, ...patch })}
            error={versionError}
            showTrialToggle
          />
          {createAction.error ? <p className="mt-3 text-sm text-red-600">{createAction.error}</p> : null}
          <button
            type="button"
            className="btn-primary mt-4 w-full"
            onClick={submitCreate}
            disabled={createAction.pending}
          >
            {createAction.pending ? '保存中…' : '保存订阅'}
          </button>
        </Card>
      ) : (
        <>
          <Card>
            <SectionTitle>当前生效版本（已冻结）</SectionTitle>
            {currentVersion ? (
              <div className="space-y-1 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">生效日</span>
                  <span>{formatDate(currentVersion.effective_from)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">价格</span>
                  <span className="tabular font-medium">
                    {formatMoney(currentVersion.amount_minor, currentVersion.currency)} /{' '}
                    {describeCycle(currentVersion.cycle_type, currentVersion.cycle_days)}
                  </span>
                </div>
                {currentVersion.plan_name ? (
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">套餐名</span>
                    <span>{currentVersion.plan_name}</span>
                  </div>
                ) : null}
                <div className="flex items-center justify-between pt-1">
                  <span className="text-slate-500">状态</span>
                  <Badge tone="muted">已生效 · 金额/币种/周期不可改</Badge>
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-500">还没有生效中的价格版本。</p>
            )}
          </Card>

          <Card>
            <SectionTitle>调整价格</SectionTitle>
            {hint ? (
              <div className="mb-3">
                <NoticeBanner
                  level={hint.needsNewVersion ? 'warn' : 'info'}
                  title={hint.needsNewVersion ? '改动会新建一个价格版本' : '暂时不需要新建版本'}
                  detail={hint.message}
                />
              </div>
            ) : null}

            <VersionFields
              draft={priceVersion}
              onChange={(patch) => setPriceVersion({ ...priceVersion, ...patch })}
              error={versionError}
              duplicateWarning={
                duplicateDay
                  ? `⚠️ ${priceVersion.effectiveFrom} 已经有一个版本了（同订阅同一天只能一个），请换一个生效日。`
                  : null
              }
            />

            {versionAction.error ? <p className="mt-3 text-sm text-red-600">{versionAction.error}</p> : null}

            <button
              type="button"
              className="btn-primary mt-4 w-full"
              onClick={submitNewVersion}
              disabled={versionAction.pending || duplicateDay}
            >
              {versionAction.pending ? '保存中…' : '新增价格版本'}
            </button>
            <p className="mt-2 text-xs text-slate-500">
              已生效版本不会被修改；历史扣款仍然按当时的版本记账，只有新版本生效日之后的账目按新价格计算。
            </p>
          </Card>
        </>
      )}
    </Stack>
  );
}
