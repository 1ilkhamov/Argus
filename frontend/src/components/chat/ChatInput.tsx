import { useState, useRef, useCallback } from 'react';

import { ArrowUp, Mic, Square, X } from 'lucide-react';

import { APP_CONFIG } from '@/config';
import { useLangStore } from '@/stores/ui/lang.store';
import { useVoiceRecorder } from '@/hooks/useVoiceRecorder';

interface ChatInputProps {
  onSend: (content: string) => Promise<void>;
  onSendVoice: (blob: Blob) => Promise<void>;
  onError: (message: string) => void;
  disabled: boolean;
}

export function ChatInput({ onSend, onSendVoice, onError, disabled }: ChatInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { t } = useLangStore();

  const voice = useVoiceRecorder({
    onRecorded: onSendVoice,
    onError,
  });

  const handleSubmit = useCallback(() => {
    const nextValue = value.trim();
    if (!nextValue || disabled) return;

    void (async () => {
      try {
        await onSend(nextValue);
        setValue('');
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
      } catch {
        return;
      }
    })();
  }, [value, disabled, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleInput = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, APP_CONFIG.maxTextareaHeight)}px`;
    }
  }, []);

  const hasContent = value.trim().length > 0;
  const isRecording = voice.state === 'recording';
  const isSendingVoice = voice.state === 'sending';
  const isVoiceBusy = isRecording || isSendingVoice;

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div className="px-4 pb-4 pt-1.5 sm:px-6 sm:pb-5">
      <div className="mx-auto max-w-4xl">
        <div
          className="accent-ring flex items-center gap-2.5 rounded-[20px] px-3.5 py-2.5 transition-all"
          style={{
            background: 'var(--bg-input)',
            border: isRecording ? '1px solid var(--error-border)' : '1px solid var(--border-primary)',
            backdropFilter: 'blur(18px)',
          }}
        >
          {isRecording ? (
            <>
              {/* Recording UI */}
              <button
                onClick={voice.cancelRecording}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-all"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                title={t('common.dismiss')}
              >
                <X size={15} strokeWidth={2.15} />
              </button>
              <div className="flex flex-1 items-center gap-2.5">
                <span
                  className="inline-block h-2 w-2 animate-pulse rounded-full"
                  style={{ background: 'var(--error-text)' }}
                />
                <span className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                  {t('chat.voiceRecording')} {formatDuration(voice.duration)}
                </span>
              </div>
              <button
                onClick={voice.stopRecording}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-all"
                style={{
                  background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%)',
                  color: 'var(--text-inverse)',
                  boxShadow: '0 8px 18px rgba(8, 14, 16, 0.16), 0 0 12px var(--accent-glow)',
                }}
              >
                <Square size={13} strokeWidth={2.15} fill="currentColor" />
              </button>
            </>
          ) : (
            <>
              {/* Normal input UI */}
              <textarea
                ref={textareaRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                onInput={handleInput}
                placeholder={
                  isSendingVoice ? t('chat.voiceTranscribing') : t('chat.inputPlaceholder')
                }
                disabled={disabled || isSendingVoice}
                rows={1}
                className="flex-1 resize-none bg-transparent text-[13px] leading-[1.45] outline-none placeholder:text-[var(--text-tertiary)]"
                style={{
                  color: 'var(--text-primary)',
                  caretColor: 'var(--accent)',
                  maxHeight: `${APP_CONFIG.maxTextareaHeight}px`,
                }}
              />
              {hasContent ? (
                <button
                  onClick={handleSubmit}
                  disabled={disabled}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-all"
                  style={{
                    background:
                      !disabled
                        ? 'linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%)'
                        : 'var(--bg-tertiary)',
                    color: !disabled ? 'var(--text-inverse)' : 'var(--text-tertiary)',
                    cursor: !disabled ? 'pointer' : 'default',
                    boxShadow:
                      !disabled ? '0 8px 18px rgba(8, 14, 16, 0.16), 0 0 12px var(--accent-glow)' : 'none',
                  }}
                >
                  <ArrowUp size={15} strokeWidth={2.15} />
                </button>
              ) : (
                <button
                  onClick={() => void voice.startRecording()}
                  disabled={disabled || isSendingVoice}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-all"
                  style={{
                    background:
                      !disabled && !isSendingVoice ? 'var(--bg-tertiary)' : 'var(--bg-tertiary)',
                    color:
                      !disabled && !isSendingVoice ? 'var(--text-secondary)' : 'var(--text-tertiary)',
                    cursor: !disabled && !isSendingVoice ? 'pointer' : 'default',
                  }}
                  title={t('chat.voiceRecord')}
                >
                  <Mic size={15} strokeWidth={2.15} />
                </button>
              )}
            </>
          )}
        </div>
        <p className="mt-1.5 text-center text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
          {isVoiceBusy
            ? isSendingVoice
              ? t('chat.voiceTranscribing')
              : t('chat.voiceRecording')
            : t('chat.inputHint')}
        </p>
      </div>
    </div>
  );
}
