import type { RefObject } from 'react';

import { Orbit } from 'lucide-react';

import { Spinner } from '@/components/common';
import type { Message, ToolCallStatus } from '@/types/chat.types';
import { useLangStore } from '@/stores/ui/lang.store';
import { MessageBubble } from './MessageBubble';
import { ToolCallIndicator } from './ToolCallIndicator';

interface MessageListProps {
  messages: Message[];
  isLoading: boolean;
  isStreaming: boolean;
  activeToolCalls: ToolCallStatus[];
  messagesEndRef: RefObject<HTMLDivElement>;
}

export function MessageList({ messages, isLoading, isStreaming, activeToolCalls, messagesEndRef }: MessageListProps) {
  const { t } = useLangStore();

  if (isLoading && messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10">
        <div
          className="surface-card-muted flex items-center gap-3 rounded-2xl px-5 py-4 text-sm"
          style={{ color: 'var(--text-secondary)' }}
        >
          <Spinner size={16} />
          <span>{t('common.loading')}</span>
        </div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="surface-card-muted max-w-xl rounded-[28px] px-8 py-10 text-center">
          <div
            className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-[22px]"
            style={{
              background:
                'linear-gradient(180deg, color-mix(in srgb, var(--panel-surface) 88%, var(--accent) 12%) 0%, var(--panel-surface) 100%)',
              border: '1px solid var(--border-secondary)',
              boxShadow: '0 0 16px var(--accent-glow)',
            }}
          >
            <Orbit size={28} strokeWidth={1.9} style={{ color: 'var(--accent-strong)' }} />
          </div>
          <h2 className="mb-3 text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
            {t('chat.greeting')}
          </h2>
          <p className="mx-auto max-w-md text-sm leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
            {t('chat.greetingSubtext')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-4xl space-y-5">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}

        {isStreaming && activeToolCalls.length > 0 && (
          <ToolCallIndicator toolCalls={activeToolCalls} />
        )}

        {isStreaming && messages[messages.length - 1]?.role === 'assistant' && !messages[messages.length - 1]?.content && activeToolCalls.length === 0 && (
          <div
            className="surface-card-muted ml-12 flex w-fit items-center gap-2 rounded-full px-3 py-2 text-sm"
            style={{ color: 'var(--text-tertiary)' }}
          >
            <Spinner size={14} />
            <span>{t('chat.thinking')}</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}
