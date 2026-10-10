/**
 * 无依赖的通用组件（不引入任何 UI 库，样式全部走 Tailwind）。
 */

import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import type { Tone } from '../lib/format';

// ---------------------------------------------------------------------------
// 容器
// ---------------------------------------------------------------------------

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return <div className={`card ${className}`}>{children}</div>;
}

export function SectionTitle({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="mb-2 flex items-end justify-between gap-2">
      <h2 className="text-sm font-semibold tracking-wide text-slate-500">{children}</h2>
      {action}
    </div>
  );
}

export function Stack({ children }: { children: ReactNode }): JSX.Element {
  return <div className="space-y-4">{children}</div>;
}

// ---------------------------------------------------------------------------
// 徽标 / 提示
// ---------------------------------------------------------------------------

const TONE_CLASSES: Record<Tone, string> = {
  ok: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  danger: 'bg-red-50 text-red-700 ring-red-200',
  warn: 'bg-amber-50 text-amber-700 ring-amber-200',
  muted: 'bg-slate-100 text-slate-600 ring-slate-200',
  info: 'bg-sky-50 text-sky-700 ring-sky-200',
};

export function Badge({ tone = 'muted', children }: { tone?: Tone; children: ReactNode }): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

export function NoticeBanner({
  level,
  title,
  detail,
}: {
  level: 'info' | 'warn' | 'danger';
  title: ReactNode;
  detail?: ReactNode;
}): JSX.Element {
  const classes =
    level === 'danger'
      ? 'bg-red-50 text-red-800 ring-red-200'
      : level === 'warn'
        ? 'bg-amber-50 text-amber-900 ring-amber-200'
        : 'bg-sky-50 text-sky-900 ring-sky-200';
  return (
    <div className={`rounded-2xl p-3 text-sm ring-1 ${classes}`} role="status">
      <p className="font-semibold">{title}</p>
      {detail ? <p className="mt-1 leading-relaxed opacity-90">{detail}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

export function Spinner(): JSX.Element {
  return (
    <span
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700"
      aria-hidden="true"
    />
  );
}

export function LoadingBlock({ label = '加载中…' }: { label?: string }): JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
      <Spinner />
      {label}
    </div>
  );
}

export function ErrorBlock({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div className="rounded-2xl bg-red-50 p-3 text-sm text-red-800 ring-1 ring-red-200">
      <p className="font-semibold">加载失败</p>
      <p className="mt-1 leading-relaxed">{message}</p>
      {onRetry ? (
        <button type="button" className="btn-secondary mt-3" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}

export function EmptyBlock({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="rounded-2xl bg-white p-8 text-center ring-1 ring-slate-200">
      <p className="font-medium text-slate-700">{title}</p>
      {detail ? <p className="mt-1 text-sm text-slate-500">{detail}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 表单
// ---------------------------------------------------------------------------

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs leading-relaxed text-slate-500">{hint}</span> : null}
      {error ? <span className="mt-1 block text-xs text-red-600">{error}</span> : null}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return <input {...props} className={`input ${props.className ?? ''}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>): JSX.Element {
  return <select {...props} className={`input ${props.className ?? ''}`} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return <textarea {...props} className={`input ${props.className ?? ''}`} />;
}

// ---------------------------------------------------------------------------
// 展示
// ---------------------------------------------------------------------------

export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'danger';
}): JSX.Element {
  return (
    <div
      className={`rounded-2xl p-3 ring-1 ${
        tone === 'danger' ? 'bg-red-50 ring-red-200' : 'bg-white ring-slate-200'
      }`}
    >
      <p className={`text-xs ${tone === 'danger' ? 'text-red-700' : 'text-slate-500'}`}>{label}</p>
      <p
        className={`tabular mt-1 text-xl font-semibold ${
          tone === 'danger' ? 'text-red-700' : 'text-slate-900'
        }`}
      >
        {value}
      </p>
      {hint ? (
        <p className={`mt-0.5 text-xs ${tone === 'danger' ? 'text-red-600' : 'text-slate-500'}`}>{hint}</p>
      ) : null}
    </div>
  );
}

export function KeyValue({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className="text-right text-slate-900">{children}</span>
    </div>
  );
}
