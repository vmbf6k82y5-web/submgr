import { useEffect, useState } from 'react';
import {
  DATA_MODE_LABELS,
  DEFAULT_CONN,
  MOCK_SCENARIO_LABELS,
  getConn,
  setConn,
  type DataMode,
  type MockScenario,
} from '../lib/conn';
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
import { useAction, useApi, useConn } from '../hooks/useApi';
import { apiDelete, apiPost, apiPut } from '../lib/api';
import type { ChannelDto, SettingsDto } from '../lib/types';

const COMMON_CURRENCIES = ['CNY', 'USD', 'HKD', 'JPY', 'EUR', 'GBP', 'KRW', 'SGD', 'TWD', 'AUD', 'CAD'];

const FALLBACK_TIMEZONES = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Seoul',
  'Asia/Kolkata',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'Australia/Sydney',
  'UTC',
];

function timezoneOptions(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    const zones = supported ? supported('timeZone') : null;
    if (zones && zones.length > 0) return zones;
  } catch {
    // 老浏览器没有这个 API
  }
  return FALLBACK_TIMEZONES;
}

/** 设置：账本配置（服务端）+ 日历订阅 + 提醒渠道 + 前端连接配置。 */
export function SettingsPage(): JSX.Element {
  const conn = useConn();
  const settingsQuery = useApi<{ item: SettingsDto }>('/api/settings');
  const channelsQuery = useApi<{ items: ChannelDto[] }>('/api/channels');

  const settings = settingsQuery.data?.item ?? null;
  const saveAction = useAction();
  const icsAction = useAction();
  const channelAction = useAction();
  const deleteAction = useAction();

  // 账本设置草稿
  const [baseCurrency, setBaseCurrency] = useState('CNY');
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [amortizeMonths, setAmortizeMonths] = useState('36');
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [copyFlash, setCopyFlash] = useState<string | null>(null);

  // 连接配置草稿
  const [apiBase, setApiBase] = useState(conn.apiBase);
  const [token, setToken] = useState(conn.token);
  const [mode, setMode] = useState<DataMode>(conn.mode);
  const [scenario, setScenario] = useState<MockScenario>(conn.mockScenario);

  // 渠道表单
  const [channelType, setChannelType] = useState<'feishu' | 'telegram'>('feishu');
  const [channelName, setChannelName] = useState('');
  const [channelConfig, setChannelConfig] = useState('{}');
  const [channelSecretRef, setChannelSecretRef] = useState('');
  const [channelEncrypted, setChannelEncrypted] = useState('');

  useEffect(() => {
    if (!settings) return;
    setBaseCurrency(settings.base_currency);
    setTimezone(settings.timezone);
    setAmortizeMonths(String(settings.amortize_lifetime_months));
  }, [settings]);

  useEffect(() => {
    setApiBase(conn.apiBase);
    setToken(conn.token);
    setMode(conn.mode);
    setScenario(conn.mockScenario);
  }, [conn.apiBase, conn.token, conn.mode, conn.mockScenario]);

  const icsUrl = (() => {
    const origin = conn.apiBase.trim() !== ''
      ? conn.apiBase.trim().replace(/\/+$/, '')
      : typeof window !== 'undefined'
        ? window.location.origin
        : '';
    return settings ? `${origin}${settings.ics_path}` : '';
  })();

  const saveLedgerSettings = async (): Promise<void> => {
    const months = Number(amortizeMonths);
    if (!Number.isInteger(months) || months < 0) {
      saveAction.setError('终身摊销月数必须是不小于 0 的整数');
      return;
    }
    const result = await saveAction.run(() =>
      apiPut<{ item: SettingsDto }>('/api/settings', {
        base_currency: baseCurrency.trim().toUpperCase(),
        timezone: timezone.trim(),
        amortize_lifetime_months: months,
      }),
    );
    if (result) {
      setSavedFlash('账本设置已保存。基准币种改了以后，历史扣款仍按冻结时的币种记账。');
      settingsQuery.reload();
    }
  };

  const copyIcs = async (): Promise<void> => {
    if (icsUrl === '') return;
    try {
      await navigator.clipboard.writeText(icsUrl);
      setCopyFlash('已复制到剪贴板，粘贴到手机日历的「订阅日历」里即可。');
    } catch {
      setCopyFlash('浏览器不允许自动复制，请长按下面的地址手动复制。');
    }
  };

  const resetIcs = async (): Promise<void> => {
    if (!window.confirm('重置后旧地址立刻失效（日历客户端需要重新订阅），确定吗？')) return;
    const result = await icsAction.run(() =>
      apiPost<{ item: SettingsDto }>('/api/settings/reset-ics-token'),
    );
    if (result) {
      setCopyFlash('ICS 令牌已重置，请重新复制地址。');
      settingsQuery.reload();
    }
  };

  const createChannel = async (): Promise<void> => {
    let configJson: unknown = {};
    if (channelConfig.trim() !== '') {
      try {
        configJson = JSON.parse(channelConfig);
      } catch {
        channelAction.setError('config_json 不是合法的 JSON');
        return;
      }
    }
    const result = await channelAction.run(() =>
      apiPost<{ item: ChannelDto }>('/api/channels', {
        type: channelType,
        name: channelName.trim(),
        config_json: configJson,
        secret_ref: channelSecretRef.trim() === '' ? null : channelSecretRef.trim(),
        secrets_encrypted: channelEncrypted.trim() === '' ? null : channelEncrypted.trim(),
      }),
    );
    if (result) {
      setChannelName('');
      setChannelConfig('{}');
      setChannelSecretRef('');
      setChannelEncrypted('');
      channelsQuery.reload();
    }
  };

  const deleteChannel = async (channel: ChannelDto): Promise<void> => {
    if (!window.confirm(`删除提醒渠道「${channel.name}」？密钥本身在 Worker secret 里，不受影响。`)) return;
    const result = await deleteAction.run(() => apiDelete<{ deleted: boolean }>(`/api/channels/${channel.id}`));
    if (result) channelsQuery.reload();
  };

  if (settingsQuery.loading && !settings) return <LoadingBlock />;
  if (settingsQuery.error) return <ErrorBlock message={settingsQuery.error} onRetry={settingsQuery.reload} />;

  const channels = channelsQuery.data?.items ?? [];

  return (
    <Stack>
      <div>
        <h2 className="text-base font-semibold text-slate-900">设置</h2>
        <p className="text-xs text-slate-500">账本口径、日历订阅、提醒渠道与本地连接</p>
      </div>

      {/* ---------------------------------------------------------------- */}
      <Card>
        <SectionTitle>账本设置</SectionTitle>
        <div className="space-y-3">
          <Field label="基准币种" hint="月均/年均/趋势都以它为单位">
            <TextInput
              list="submgr-settings-currencies"
              value={baseCurrency}
              maxLength={3}
              onChange={(event) => setBaseCurrency(event.target.value.toUpperCase())}
            />
            <datalist id="submgr-settings-currencies">
              {COMMON_CURRENCIES.map((code) => (
                <option key={code} value={code} />
              ))}
            </datalist>
          </Field>

          <Field label="时区" hint="「今天」、到期日与提醒时间的判断基准">
            <Select value={timezone} onChange={(event) => setTimezone(event.target.value)}>
              {timezoneOptions().map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="终身订阅摊销月数" hint="0 表示终身订阅不计入月均">
            <TextInput
              inputMode="numeric"
              value={amortizeMonths}
              onChange={(event) => setAmortizeMonths(event.target.value)}
            />
          </Field>
        </div>
        {saveAction.error ? <p className="mt-2 text-sm text-red-600">{saveAction.error}</p> : null}
        {savedFlash ? (
          <div className="mt-3">
            <NoticeBanner level="info" title={savedFlash} />
          </div>
        ) : null}
        <button type="button" className="btn-primary mt-3 w-full" onClick={saveLedgerSettings} disabled={saveAction.pending}>
          {saveAction.pending ? '保存中…' : '保存账本设置'}
        </button>
      </Card>

      {/* ---------------------------------------------------------------- */}
      <Card>
        <SectionTitle>日历订阅（ICS）</SectionTitle>
        <p className="text-xs text-slate-500">
          把这个地址加到手机日历的「订阅日历」里，到期日会自动同步（令牌即凭证，不需要登录）。
        </p>
        <TextInput readOnly value={icsUrl} onFocus={(event) => event.target.select()} className="mt-2 text-xs" />
        {copyFlash ? (
          <div className="mt-2">
            <NoticeBanner level="info" title={copyFlash} />
          </div>
        ) : null}
        {icsAction.error ? <p className="mt-2 text-sm text-red-600">{icsAction.error}</p> : null}
        <div className="mt-3 flex gap-2">
          <button type="button" className="btn-primary flex-1" onClick={copyIcs}>
            复制链接
          </button>
          <button type="button" className="btn-danger flex-1" onClick={resetIcs} disabled={icsAction.pending}>
            {icsAction.pending ? '重置中…' : '重置令牌'}
          </button>
        </div>
      </Card>

      {/* ---------------------------------------------------------------- */}
      <Card>
        <SectionTitle>提醒渠道</SectionTitle>
        <ul className="divide-y divide-slate-100">
          {channels.map((channel) => (
            <li key={channel.id} className="flex items-start justify-between gap-3 py-2">
              <div>
                <p className="text-sm font-medium text-slate-800">
                  {channel.name}{' '}
                  <Badge tone="info">{channel.type === 'feishu' ? '飞书' : 'Telegram'}</Badge>
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {channel.secret_ref ? `密钥来自 secret：${channel.secret_ref}` : '密钥为加密密文'}
                  {channel.has_secrets_encrypted ? ' · 已存密文' : ''}
                  {channel.config_json !== '{}' ? ` · ${channel.config_json}` : ''}
                </p>
              </div>
              <button type="button" className="btn-danger" onClick={() => deleteChannel(channel)}>
                删除
              </button>
            </li>
          ))}
          {channels.length === 0 ? <li className="py-2 text-sm text-slate-400">还没有提醒渠道</li> : null}
        </ul>

        <div className="mt-3 space-y-3 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
          <p className="text-sm font-medium text-slate-700">新增渠道</p>
          <div className="grid grid-cols-2 gap-2">
            <Field label="类型">
              <Select value={channelType} onChange={(event) => setChannelType(event.target.value as typeof channelType)}>
                <option value="feishu">飞书</option>
                <option value="telegram">Telegram</option>
              </Select>
            </Field>
            <Field label="名称">
              <TextInput value={channelName} onChange={(event) => setChannelName(event.target.value)} />
            </Field>
          </div>
          <Field
            label="非敏感配置（JSON）"
            hint={'例如 Telegram 的 {"chat_id":"123"}；不要放密钥'}
          >
            <TextArea rows={2} value={channelConfig} onChange={(event) => setChannelConfig(event.target.value)} />
          </Field>
          <Field label="secret_ref（环境变量名）" hint="密钥值用 wrangler secret put 写入，库里只存名字">
            <TextInput
              placeholder="FEISHU_MAIN"
              value={channelSecretRef}
              onChange={(event) => setChannelSecretRef(event.target.value.toUpperCase())}
            />
          </Field>
          <Field label="或：加密密文 secrets_encrypted" hint="AES-256-GCM 密文；与 secret_ref 至少填一个">
            <TextInput value={channelEncrypted} onChange={(event) => setChannelEncrypted(event.target.value)} />
          </Field>
          {channelAction.error ? <p className="text-sm text-red-600">{channelAction.error}</p> : null}
          <button
            type="button"
            className="btn-primary w-full"
            onClick={createChannel}
            disabled={channelAction.pending || channelName.trim() === ''}
          >
            {channelAction.pending ? '保存中…' : '新增渠道'}
          </button>
        </div>
        {channelsQuery.error ? <p className="mt-2 text-sm text-red-600">{channelsQuery.error}</p> : null}
        {deleteAction.error ? <p className="mt-2 text-sm text-red-600">{deleteAction.error}</p> : null}
      </Card>

      {/* ---------------------------------------------------------------- */}
      <Card>
        <SectionTitle>本地连接（只存在这台设备上）</SectionTitle>
        <p className="text-xs text-slate-500">
          令牌只保存在浏览器 localStorage，不会写进前端产物。线上由 Worker 托管前端时，API 地址留空即可（同源）。
        </p>
        <div className="mt-3 space-y-3">
          <Field label="API 地址" hint="留空 = 同源；本地 Vite 开发默认代理到 http://127.0.0.1:8787">
            <TextInput
              placeholder="https://submgr.xxx.workers.dev"
              value={apiBase}
              onChange={(event) => setApiBase(event.target.value)}
            />
          </Field>
          <Field label="ADMIN_TOKEN">
            <TextInput
              type="password"
              placeholder="Bearer 令牌"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </Field>
          <Field label="数据模式">
            <Select value={mode} onChange={(event) => setMode(event.target.value as DataMode)}>
              {(Object.keys(DATA_MODE_LABELS) as DataMode[]).map((value) => (
                <option key={value} value={value}>
                  {DATA_MODE_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="示例数据场景" hint="只在用示例数据时生效，用来预览汇率异常提示">
            <Select value={scenario} onChange={(event) => setScenario(event.target.value as MockScenario)}>
              {(Object.keys(MOCK_SCENARIO_LABELS) as MockScenario[]).map((value) => (
                <option key={value} value={value}>
                  {MOCK_SCENARIO_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            className="btn-primary flex-1"
            onClick={() => {
              setConn({ apiBase, token, mode, mockScenario: scenario });
              setCopyFlash('连接配置已保存。');
            }}
          >
            保存连接配置
          </button>
          <button
            type="button"
            className="btn-secondary flex-1"
            onClick={() => {
              setConn(DEFAULT_CONN);
              setCopyFlash('已恢复默认连接配置。');
            }}
          >
            恢复默认
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-400">当前：{getConn().mode} · 令牌{getConn().token ? '已配置' : '未配置'}</p>
      </Card>
    </Stack>
  );
}
