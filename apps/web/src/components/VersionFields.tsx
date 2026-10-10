/**
 * 价格版本表单字段（新建订阅的「首个版本」与「调价新建版本」共用）。
 */

import { Field, Select, TextInput } from './ui';
import { CYCLE_OPTIONS, COMMON_CURRENCIES, type VersionDraft } from '../lib/versioning';

export interface VersionFieldsProps {
  draft: VersionDraft;
  onChange: (patch: Partial<VersionDraft>) => void;
  error?: { field?: keyof VersionDraft; message: string } | null;
  /** 新建订阅时可以顺手标记试用；调价时一般用不到 */
  showTrialToggle?: boolean;
  duplicateWarning?: string | null;
}

export function VersionFields({
  draft,
  onChange,
  error,
  showTrialToggle = false,
  duplicateWarning = null,
}: VersionFieldsProps): JSX.Element {
  const fieldError = (field: keyof VersionDraft): string | null =>
    error?.field === field ? error.message : null;

  return (
    <div className="space-y-3">
      <Field
        label="生效日"
        error={fieldError('effectiveFrom')}
        hint={duplicateWarning ?? '这一天起按这个价格计算；历史扣款按当时生效的版本记账，不会被改动。'}
      >
        <TextInput
          type="date"
          value={draft.effectiveFrom}
          onChange={(event) => onChange({ effectiveFrom: event.target.value })}
        />
      </Field>

      <Field label="套餐名（可选）" error={fieldError('planName')}>
        <TextInput
          placeholder="例如：高级会员 · 连续包月"
          value={draft.planName}
          maxLength={200}
          onChange={(event) => onChange({ planName: event.target.value })}
        />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="价格" error={fieldError('amount')} hint="主单位，例如 25.00">
          <TextInput
            inputMode="decimal"
            placeholder="25.00"
            value={draft.amount}
            onChange={(event) => onChange({ amount: event.target.value })}
          />
        </Field>
        <Field label="币种" error={fieldError('currency')}>
          <TextInput
            list="submgr-currencies"
            placeholder="CNY"
            value={draft.currency}
            maxLength={3}
            onChange={(event) => onChange({ currency: event.target.value.toUpperCase() })}
          />
          <datalist id="submgr-currencies">
            {COMMON_CURRENCIES.map((code) => (
              <option key={code} value={code} />
            ))}
          </datalist>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="付费周期" error={fieldError('cycleType')}>
          <Select
            value={draft.cycleType}
            onChange={(event) => onChange({ cycleType: event.target.value as VersionDraft['cycleType'] })}
          >
            {CYCLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        {draft.cycleType === 'days' ? (
          <Field label="周期天数" error={fieldError('cycleDays')}>
            <TextInput
              inputMode="numeric"
              placeholder="30"
              value={draft.cycleDays}
              onChange={(event) => onChange({ cycleDays: event.target.value })}
            />
          </Field>
        ) : (
          <div />
        )}
      </div>

      {showTrialToggle ? (
        <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300"
              checked={draft.isTrial}
              onChange={(event) => onChange({ isTrial: event.target.checked })}
            />
            这是试用版本
          </label>
          {draft.isTrial ? (
            <div className="mt-3 space-y-3">
              <Field label="试用结束日" error={fieldError('trialEndDate')} hint="试用结束时由 Cron 自动转正">
                <TextInput
                  type="date"
                  value={draft.trialEndDate}
                  onChange={(event) => onChange({ trialEndDate: event.target.value })}
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="转正价（可选）" error={fieldError('afterTrialAmount')} hint="留空表示试用后不续费">
                  <TextInput
                    inputMode="decimal"
                    placeholder="99.00"
                    value={draft.afterTrialAmount}
                    onChange={(event) => onChange({ afterTrialAmount: event.target.value })}
                  />
                </Field>
                <Field label="转正后周期" error={fieldError('afterTrialCycleType')}>
                  <Select
                    value={draft.afterTrialCycleType}
                    onChange={(event) =>
                      onChange({ afterTrialCycleType: event.target.value as VersionDraft['afterTrialCycleType'] })
                    }
                  >
                    <option value="">未设置</option>
                    {CYCLE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
