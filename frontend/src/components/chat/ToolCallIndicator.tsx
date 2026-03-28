import { Globe, CheckCircle, XCircle, Wrench } from 'lucide-react';

import { Spinner } from '@/components/common';
import type { ToolCallStatus } from '@/types/chat.types';

const TOOL_DISPLAY: Record<string, { icon: typeof Globe; label: string }> = {
  web_search: { icon: Globe, label: 'Searching the web' },
  memory_manage: { icon: Wrench, label: 'Managing memory' },
};

const DEFAULT_DISPLAY = { icon: Wrench, label: 'Using tool' };

interface ToolCallIndicatorProps {
  toolCalls: ToolCallStatus[];
}

export function ToolCallIndicator({ toolCalls }: ToolCallIndicatorProps) {
  if (toolCalls.length === 0) return null;

  return (
    <div className="ml-[52px] flex flex-col gap-1.5">
      {toolCalls.map((tc, i) => {
        const display = TOOL_DISPLAY[tc.name] ?? DEFAULT_DISPLAY;
        const Icon = display.icon;

        return (
          <div
            key={`${tc.name}-${i}`}
            className="flex w-fit items-center gap-2 rounded-full px-3 py-1.5 text-xs"
            style={{
              background: 'var(--panel-muted)',
              border: '1px solid var(--border-secondary)',
              color: 'var(--text-secondary)',
            }}
          >
            {tc.done ? (
              tc.success !== false ? (
                <CheckCircle size={13} style={{ color: 'var(--success, #22c55e)' }} />
              ) : (
                <XCircle size={13} style={{ color: 'var(--error, #ef4444)' }} />
              )
            ) : (
              <Spinner size={13} />
            )}
            <Icon size={13} style={{ color: 'var(--accent)' }} />
            <span>
              {display.label}
              {tc.name !== 'web_search' && tc.name !== 'memory_manage' && (
                <span style={{ color: 'var(--text-tertiary)' }}> ({tc.name})</span>
              )}
            </span>
            {tc.done && tc.durationMs !== undefined && (
              <span style={{ color: 'var(--text-tertiary)' }}>
                {tc.durationMs < 1000
                  ? `${tc.durationMs}ms`
                  : `${(tc.durationMs / 1000).toFixed(1)}s`}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
