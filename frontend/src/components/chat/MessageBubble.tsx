import ReactMarkdown from 'react-markdown';

import { Bot, User } from 'lucide-react';
import type { Message } from '@/types/chat.types';

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex items-end gap-3 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl"
          style={{
            background: 'linear-gradient(135deg, var(--accent-soft) 0%, rgba(0, 0, 0, 0) 100%)',
            border: '1px solid var(--border-secondary)',
          }}
        >
          <Bot size={16} strokeWidth={1.9} style={{ color: 'var(--accent)' }} />
        </div>
      )}

      <div
        className={`max-w-[78%] border px-4 py-3 shadow-[var(--shadow-sm)] ${
          isUser ? 'rounded-[22px] rounded-br-md' : 'rounded-[22px] rounded-bl-md'
        }`}
        style={{
          background: isUser ? 'var(--bg-user-bubble)' : 'var(--bg-assistant-bubble)',
          color: isUser ? 'var(--text-inverse)' : 'var(--text-assistant)',
          borderColor: isUser ? 'rgba(255, 255, 255, 0.08)' : 'var(--border-primary)',
        }}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{message.content}</p>
        ) : (
          <div
            className="assistant-markdown prose prose-sm max-w-none text-[14px] leading-relaxed dark:prose-invert prose-p:my-1.5 prose-pre:my-2 prose-pre:rounded-2xl prose-code:text-[13px] prose-code:font-mono prose-headings:mb-2 prose-headings:mt-4 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5"
            style={{
              '--tw-prose-pre-bg': 'var(--bg-code)',
              '--tw-prose-pre-code': 'var(--text-primary)',
              '--tw-prose-body': 'var(--text-assistant)',
              '--tw-prose-headings': 'var(--text-primary)',
              '--tw-prose-links': 'var(--accent-strong)',
              '--tw-prose-bold': 'var(--text-primary)',
              '--tw-prose-bullets': 'var(--accent)',
              '--tw-prose-quotes': 'var(--text-secondary)',
              color: 'inherit',
            } as React.CSSProperties}
          >
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        )}
      </div>

      {isUser && (
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl"
          style={{
            background: 'var(--panel-muted)',
            border: '1px solid var(--border-secondary)',
          }}
        >
          <User size={16} strokeWidth={1.9} style={{ color: 'var(--text-secondary)' }} />
        </div>
      )}
    </div>
  );
}
