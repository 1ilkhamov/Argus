import { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';

interface CustomSelectProps {
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  renderLabel?: (value: string) => string;
  className?: string;
}

export function CustomSelect({ value, options, onChange, renderLabel, className = '' }: CustomSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const label = renderLabel ? renderLabel(value) : capitalize(value);

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium outline-none transition-colors"
        style={{
          background: 'var(--shell-bg)',
          borderColor: open ? 'var(--accent)' : 'var(--border-secondary)',
          color: 'var(--text-primary)',
        }}
      >
        <span className="truncate">{label}</span>
        <ChevronDown
          size={12}
          strokeWidth={2}
          className="shrink-0 transition-transform"
          style={{
            color: 'var(--text-tertiary)',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </button>

      {open && (
        <div
          className="absolute left-0 right-0 z-50 mt-1 max-h-[200px] overflow-y-auto rounded-lg border py-1 shadow-lg"
          style={{
            background: 'var(--panel-surface)',
            borderColor: 'var(--border-secondary)',
          }}
        >
          {options.map((opt) => {
            const isActive = opt === value;
            const optLabel = renderLabel ? renderLabel(opt) : capitalize(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => { onChange(opt); setOpen(false); }}
                className="flex w-full items-center px-2.5 py-1.5 text-left text-[12px] transition-colors"
                style={{
                  color: isActive ? 'var(--accent)' : 'var(--text-primary)',
                  background: isActive ? 'var(--accent-soft)' : 'transparent',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.background = 'var(--shell-bg)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = isActive ? 'var(--accent-soft)' : 'transparent';
                }}
              >
                {optLabel}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
