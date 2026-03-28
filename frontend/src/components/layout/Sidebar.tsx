import { Plus, SquareTerminal, Trash2 } from 'lucide-react';

import { APP_CONFIG } from '@/config';
import type { ConversationPreview } from '@/types/chat.types';
import { useLangStore } from '@/stores/ui/lang.store';

interface SidebarProps {
  open: boolean;
  disabled: boolean;
  conversations: ConversationPreview[];
  currentConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (id: string) => void;
}

export function Sidebar({
  open,
  disabled,
  conversations,
  currentConversationId,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
}: SidebarProps) {
  const { t } = useLangStore();

  return (
    <aside
      className="shrink-0 overflow-hidden transition-all duration-300 ease-out"
      style={{
        width: open ? `${APP_CONFIG.sidebarWidth}px` : '0px',
      }}
    >
      <div className="surface-card mr-3 flex h-full flex-col overflow-hidden rounded-[24px]">
        <div className="px-4 pb-4 pt-4">
          <button
            onClick={() => {
              if (!disabled) {
                onNewConversation();
              }
            }}
            disabled={disabled}
            className="flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold transition-all"
            style={{
              background:
                disabled
                  ? 'var(--bg-tertiary)'
                  : 'linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%)',
              color: disabled ? 'var(--text-tertiary)' : 'var(--text-inverse)',
              border: disabled ? '1px solid var(--border-primary)' : '1px solid rgba(255, 255, 255, 0.08)',
              boxShadow: disabled ? 'none' : '0 12px 24px rgba(7, 12, 18, 0.14), 0 0 14px var(--accent-glow)',
              opacity: disabled ? 0.6 : 1,
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            <Plus size={16} strokeWidth={2} />
            <span>{t('chat.newChat')}</span>
          </button>
        </div>

        <div className="accent-divider mx-4 h-px" />

        <div className="scrollbar-thin flex-1 overflow-y-auto px-3 py-3">
          {conversations.length === 0 ? (
            <div
              className="surface-card-muted mt-4 rounded-2xl px-4 py-5 text-center text-sm"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {t('chat.noConversations')}
            </div>
          ) : (
            <div className="space-y-2">
              {conversations.map((conv) => {
                const isActive = currentConversationId === conv.id;

                return (
                  <div
                    key={conv.id}
                    className={`group flex items-center gap-3 rounded-2xl px-3 py-3 ${
                      isActive ? 'sidebar-item sidebar-item-active' : 'sidebar-item'
                    }`}
                    style={{
                      opacity: disabled ? 0.55 : 1,
                      cursor: disabled ? 'not-allowed' : 'pointer',
                    }}
                    onClick={() => {
                      if (!disabled) {
                        onSelectConversation(conv.id);
                      }
                    }}
                  >
                    <div
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl"
                      style={{
                        background: isActive ? 'var(--accent-soft)' : 'var(--panel-muted)',
                        border: '1px solid var(--border-secondary)',
                      }}
                    >
                      <SquareTerminal
                        size={15}
                        strokeWidth={1.9}
                        style={{ color: isActive ? 'var(--accent)' : 'var(--text-tertiary)' }}
                      />
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{conv.title}</p>
                    </div>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!disabled) {
                          onDeleteConversation(conv.id);
                        }
                      }}
                      disabled={disabled}
                      className="icon-button flex h-8 w-8 items-center justify-center rounded-xl opacity-0 transition-all group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
                    >
                      <Trash2 size={14} strokeWidth={1.9} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

      </div>
    </aside>
  );
}
