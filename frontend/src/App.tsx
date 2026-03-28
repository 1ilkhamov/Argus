import { useState } from 'react';
import { useShallow } from 'zustand/shallow';

import { useChatStore } from '@/stores/chat/chat.store';
import { useDashboardStore } from '@/stores/ui/dashboard.store';
import { Header, NavRail, Sidebar } from '@/components/layout';
import { ChatContainer } from '@/components/chat';
import { MemoryPanel } from '@/components/memory';
import { ToolsPanel } from '@/components/tools';
import { SettingsContent } from '@/components/settings/SettingsContent';

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const activePage = useDashboardStore((s) => s.activePage);
  const {
    conversations,
    currentConversationId,
    isLoading,
    isStreaming,
    selectConversation,
    newConversation,
    deleteConversation,
  } = useChatStore(
    useShallow((state) => ({
      conversations: state.conversations,
      currentConversationId: state.currentConversationId,
      isLoading: state.isLoading,
      isStreaming: state.isStreaming,
      selectConversation: state.selectConversation,
      newConversation: state.newConversation,
      deleteConversation: state.deleteConversation,
    })),
  );

  return (
    <div className="relative h-full overflow-hidden px-3 py-3 sm:px-4 sm:py-4">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="absolute left-[-12%] top-[-20%] h-[30rem] w-[30rem] rounded-full blur-3xl"
          style={{
            background: 'radial-gradient(circle, var(--accent-ambient) 0%, rgba(0, 0, 0, 0) 68%)',
            opacity: 0.7,
          }}
        />
        <div
          className="absolute bottom-[-18%] right-[-10%] h-[26rem] w-[26rem] rounded-full blur-3xl"
          style={{
            background: 'radial-gradient(circle, var(--accent-soft) 0%, rgba(0, 0, 0, 0) 72%)',
            opacity: 0.48,
          }}
        />
      </div>

      <div className="glass-shell relative flex h-full flex-col overflow-hidden rounded-[28px]">
        <Header
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        />

        <div className="flex flex-1 overflow-hidden">
          <NavRail />

          <div className="flex flex-1 overflow-hidden p-2 sm:p-3">
            {activePage === 'chat' && (
              <Sidebar
                open={sidebarOpen}
                disabled={isStreaming || isLoading}
                conversations={conversations}
                currentConversationId={currentConversationId}
                onSelectConversation={selectConversation}
                onNewConversation={newConversation}
                onDeleteConversation={deleteConversation}
              />
            )}

            <main className="flex min-w-0 flex-1 overflow-hidden">
              {activePage === 'chat' && <ChatContainer />}
              {activePage === 'settings' && (
                <div className="surface-card flex-1 overflow-hidden rounded-[24px]">
                  <SettingsContent />
                </div>
              )}
              {activePage === 'memory' && (
                <div className="surface-card flex-1 overflow-hidden rounded-[24px]">
                  <MemoryPanel />
                </div>
              )}
              {activePage === 'tools' && (
                <div className="surface-card flex-1 overflow-hidden rounded-[24px]">
                  <ToolsPanel />
                </div>
              )}
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}
