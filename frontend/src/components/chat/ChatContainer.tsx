import { APP_CONFIG } from '@/config';
import { Spinner } from '@/components/common';
import { useChat } from '@/hooks/useChat';
import { useLangStore } from '@/stores/ui/lang.store';
import { ChatInput } from './ChatInput';
import { MessageList } from './MessageList';

export function ChatContainer() {
  const { messages, isStreaming, isLoading, activeToolCalls, messagesEndRef, handleSend, handleSendVoice, error, setError, clearError } = useChat();
  const { t } = useLangStore();

  return (
    <div className="surface-card-elevated flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-[24px]">
      {error && (
        <div
          className="mx-4 mt-4 flex items-center justify-between rounded-2xl px-4 py-3 text-sm"
          style={{
            background: 'var(--error-soft)',
            border: '1px solid var(--error-border)',
            color: 'var(--error-text)',
          }}
        >
          <span>{error}</span>
          <button onClick={clearError} className="ml-4 opacity-70 transition-opacity hover:opacity-100">
            {t('common.dismiss')}
          </button>
        </div>
      )}

      <div className="flex items-center justify-end px-5 pb-3 pt-5">
        <div
          className="flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-medium"
          style={{
            background: 'var(--panel-muted)',
            border: '1px solid var(--border-secondary)',
            color: isStreaming ? 'var(--accent-strong)' : 'var(--text-secondary)',
          }}
        >
          {isStreaming && <Spinner size={13} />}
          <span>{isStreaming ? t('chat.thinking') : `v${APP_CONFIG.version}`}</span>
        </div>
      </div>

      <div className="accent-divider mx-5 h-px" />

      <MessageList
        messages={messages}
        isLoading={isLoading}
        isStreaming={isStreaming}
        activeToolCalls={activeToolCalls}
        messagesEndRef={messagesEndRef}
      />

      <ChatInput onSend={handleSend} onSendVoice={handleSendVoice} onError={setError} disabled={isStreaming || isLoading} />
    </div>
  );
}
