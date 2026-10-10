import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useSource } from '../hooks/useApi';

/** 底部导航（手机上单手可达；桌面居中显示成一条 App 宽度）。 */
const NAV_ITEMS: { to: string; label: string; icon: (active: boolean) => JSX.Element; match: (path: string) => boolean }[] = [
  {
    to: '/',
    label: '总览',
    match: (path) => path === '/',
    icon: (active) => (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={active ? '#0f172a' : '#94a3b8'} strokeWidth="2">
        <path d="M3 10.5 12 3l9 7.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M5 9.5V21h14V9.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    to: '/subscriptions',
    label: '订阅',
    match: (path) => path.startsWith('/subscriptions'),
    icon: (active) => (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={active ? '#0f172a' : '#94a3b8'} strokeWidth="2">
        <path d="M4 6h16M4 12h16M4 18h10" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    to: '/trends',
    label: '趋势',
    match: (path) => path.startsWith('/trends'),
    icon: (active) => (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={active ? '#0f172a' : '#94a3b8'} strokeWidth="2">
        <path d="M5 20V10M12 20V4M19 20v-6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    to: '/settings',
    label: '设置',
    match: (path) => path.startsWith('/settings'),
    icon: (active) => (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={active ? '#0f172a' : '#94a3b8'} strokeWidth="2">
        <circle cx="12" cy="12" r="3.2" />
        <path d="M12 3v2.2M12 18.8V21M4.2 7.5l1.9 1.1M17.9 15.4l1.9 1.1M4.2 16.5l1.9-1.1M17.9 8.6l1.9-1.1" strokeLinecap="round" />
      </svg>
    ),
  },
];

export function Layout({ children }: { children: ReactNode }): JSX.Element {
  const location = useLocation();
  const source = useSource();
  const isMock = source.source === 'mock';

  return (
    <div className="mx-auto flex min-h-screen max-w-app flex-col bg-slate-100">
      <header className="sticky top-0 z-20 bg-slate-900 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-white">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">订阅管家</h1>
          <span className="text-xs text-slate-300">个人订阅追踪</span>
        </div>
      </header>

      {isMock ? (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          <span className="font-semibold">示例数据</span>
          {source.notice ? <span>：{source.notice}</span> : null}
          <Link to="/settings" className="ml-1 underline underline-offset-2">
            去设置真实接口
          </Link>
        </div>
      ) : null}

      <main className="flex-1 px-4 py-4 pb-28">{children}</main>

      <nav className="fixed bottom-0 left-1/2 z-20 w-full max-w-app -translate-x-1/2 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <ul className="flex">
          {NAV_ITEMS.map((item) => {
            const active = item.match(location.pathname);
            return (
              <li key={item.to} className="flex-1">
                <Link
                  to={item.to}
                  className={`flex flex-col items-center gap-0.5 py-2 text-[11px] ${
                    active ? 'font-semibold text-slate-900' : 'text-slate-400'
                  }`}
                >
                  {item.icon(active)}
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
