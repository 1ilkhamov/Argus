import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Search } from 'lucide-react';

/* ─── Page Header ─────────────────────────────────────────────────────────── */

interface PageHeaderProps {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

export function PageHeader({ icon: Icon, title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="flex items-center gap-3 px-6 pb-3 pt-5">
      <div
        className="flex h-9 w-9 items-center justify-center rounded-2xl"
        style={{
          background: 'var(--accent-soft)',
          border: '1px solid var(--border-secondary)',
        }}
      >
        <Icon size={16} style={{ color: 'var(--accent)' }} />
      </div>
      <div className="flex-1">
        <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          {title}
        </h2>
        {subtitle && (
          <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            {subtitle}
          </div>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ─── Tab Bar ─────────────────────────────────────────────────────────────── */

export interface TabItem<T extends string = string> {
  key: T;
  label: string;
  icon?: LucideIcon;
  count?: number;
}

interface TabBarProps<T extends string = string> {
  tabs: TabItem<T>[];
  activeTab: T;
  onChange: (tab: T) => void;
  variant?: 'underline' | 'pill';
}

export function TabBar<T extends string>({ tabs, activeTab, onChange, variant = 'underline' }: TabBarProps<T>) {
  if (variant === 'pill') {
    return (
      <div className="flex gap-1 px-6 pb-3">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.key;
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => onChange(tab.key)}
              className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12px] font-medium transition-all"
              style={{
                background: isActive ? 'var(--accent-soft)' : 'transparent',
                color: isActive ? 'var(--accent)' : 'var(--text-tertiary)',
                border: isActive ? '1px solid var(--accent)' : '1px solid transparent',
              }}
            >
              {Icon && <Icon size={12} strokeWidth={1.9} />}
              {tab.label}
              {tab.count !== undefined && (
                <span
                  className="ml-1 rounded-md px-1.5 py-0.5 text-[10px]"
                  style={{
                    background: isActive ? 'var(--accent)' : 'var(--bg-tertiary)',
                    color: isActive ? 'var(--text-inverse)' : 'var(--text-tertiary)',
                  }}
                >
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      className="flex gap-1 border-b px-6 pt-1 pb-0"
      style={{ borderColor: 'var(--border-primary)' }}
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.key;
        const Icon = tab.icon;
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            className="flex items-center gap-1.5 rounded-t-lg px-4 py-2 text-xs font-medium transition-colors"
            style={{
              background: isActive ? 'var(--panel-surface)' : 'transparent',
              color: isActive ? 'var(--accent)' : 'var(--text-tertiary)',
              borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >
            {Icon && <Icon size={13} strokeWidth={1.9} />}
            {tab.label}
            {tab.count !== undefined && (
              <span
                className="ml-1 rounded-md px-1.5 py-0.5 text-[10px]"
                style={{
                  background: isActive ? 'var(--accent)' : 'var(--bg-tertiary)',
                  color: isActive ? 'var(--text-inverse)' : 'var(--text-tertiary)',
                }}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ─── Search Bar ──────────────────────────────────────────────────────────── */

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}

export function PageSearchBar({ value, onChange, placeholder }: SearchBarProps) {
  return (
    <div className="px-6 pb-3">
      <div
        className="flex items-center gap-2 rounded-xl px-3 py-1.5"
        style={{ background: 'var(--panel-muted)', border: '1px solid var(--border-secondary)' }}
      >
        <Search size={13} style={{ color: 'var(--text-tertiary)' }} />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="flex-1 bg-transparent text-[12px] outline-none"
          style={{ color: 'var(--text-primary)' }}
        />
      </div>
    </div>
  );
}

/* ─── Divider ─────────────────────────────────────────────────────────────── */

export function PageDivider() {
  return <div className="accent-divider mx-6 h-px" />;
}

/* ─── Scroll Area ─────────────────────────────────────────────────────────── */

interface PageScrollAreaProps {
  children: ReactNode;
}

export function PageScrollArea({ children }: PageScrollAreaProps) {
  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto px-6 py-4">
      {children}
    </div>
  );
}

/* ─── Footer ──────────────────────────────────────────────────────────────── */

interface PageFooterProps {
  children: ReactNode;
}

export function PageFooter({ children }: PageFooterProps) {
  return (
    <div
      className="border-t px-6 py-3"
      style={{ borderColor: 'var(--border-primary)' }}
    >
      {children}
    </div>
  );
}

/* ─── Error Banner ────────────────────────────────────────────────────────── */

interface PageErrorProps {
  message: string;
  onDismiss: () => void;
  dismissLabel?: string;
}

export function PageError({ message, onDismiss, dismissLabel = 'Dismiss' }: PageErrorProps) {
  return (
    <div
      className="mx-6 mt-3 rounded-xl px-4 py-3 text-sm"
      style={{ background: 'var(--error-soft)', color: 'var(--error-text)' }}
    >
      {message}
      <button onClick={onDismiss} className="ml-2 underline">{dismissLabel}</button>
    </div>
  );
}

/* ─── Loading State ───────────────────────────────────────────────────────── */

interface PageLoadingProps {
  label?: string;
}

export function PageLoading({ label = 'Loading…' }: PageLoadingProps) {
  return (
    <div className="flex items-center justify-center py-12" style={{ color: 'var(--text-tertiary)' }}>
      {label}
    </div>
  );
}

/* ─── Empty State ─────────────────────────────────────────────────────────── */

interface PageEmptyProps {
  label: string;
}

export function PageEmpty({ label }: PageEmptyProps) {
  return (
    <div className="py-8 text-center text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
      {label}
    </div>
  );
}
