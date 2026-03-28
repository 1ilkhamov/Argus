import { useEffect, useCallback, useRef } from 'react';
import { useShallow } from 'zustand/shallow';

import { useChatStore } from '@/stores/chat/chat.store';

export function useChat() {
  const {
    messages,
    isStreaming,
    isLoading,
    activeToolCalls,
    error,
    setError,
    clearError,
    loadConversations,
    sendMessage,
    sendVoiceMessage,
  } = useChatStore(
    useShallow((s) => ({
      messages: s.messages,
      isStreaming: s.isStreaming,
      isLoading: s.isLoading,
      activeToolCalls: s.activeToolCalls,
      error: s.error,
      setError: s.setError,
      clearError: s.clearError,
      loadConversations: s.loadConversations,
      sendMessage: s.sendMessage,
      sendVoiceMessage: s.sendVoiceMessage,
    })),
  );

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = useCallback(
    async (content: string) => {
      if (!content.trim() || isStreaming || isLoading) return;
      await sendMessage(content.trim());
    },
    [isLoading, isStreaming, sendMessage],
  );

  const handleSendVoice = useCallback(
    async (blob: Blob) => {
      if (isStreaming || isLoading) return;
      await sendVoiceMessage(blob);
    },
    [isLoading, isStreaming, sendVoiceMessage],
  );

  return {
    messages,
    isStreaming,
    isLoading,
    activeToolCalls,
    error,
    setError,
    clearError,
    messagesEndRef,
    handleSend,
    handleSendVoice,
  };
}
