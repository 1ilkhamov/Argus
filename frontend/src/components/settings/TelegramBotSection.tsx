import { useEffect, useState, useCallback } from 'react';
import { Eye, EyeOff, Loader2, Power, ExternalLink } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings/settings.store';
import { useLangStore } from '@/stores/ui/lang.store';
import { getTranslation } from '@/i18n';
import { telegramApi, type TelegramStatus } from '@/api/resources/telegram.api';

export function TelegramBotSection() {
  const { lang } = useLangStore();
  const t = (key: Parameters<typeof getTranslation>[1]) => getTranslation(lang, key);
  const { settings, fetchSettings, updateSetting } = useSettingsStore();

  const [tgStatus, setTgStatus] = useState<TelegramStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [tgToken, setTgToken] = useState('');
  const [tgUsers, setTgUsers] = useState('');
  const [showToken, setShowToken] = useState(false);

  const fetchTgStatus = useCallback(async () => {
    try { setTgStatus(await telegramApi.getStatus()); } catch { setTgStatus(null); }
  }, []);

  useEffect(() => { fetchTgStatus(); }, [fetchTgStatus]);

  const handleConnect = async () => {
    setBusy(true);
    try {
      if (tgToken.trim()) { await updateSetting('telegram.bot_token', tgToken.trim()); setTgToken(''); }
      if (tgUsers.trim()) { await updateSetting('telegram.allowed_users', tgUsers.trim()); setTgUsers(''); }
      setTgStatus(await telegramApi.restart());
      await fetchSettings();
    } catch { /* ignore */ } finally { setBusy(false); }
  };

  const handleStop = async () => {
    setBusy(true);
    try { setTgStatus(await telegramApi.stop()); } catch { /* ignore */ } finally { setBusy(false); }
  };

  const running = tgStatus?.running;

  return (
    <>
      {/* Status */}
      <div className="flex items-center gap-2 rounded-2xl px-4 py-2.5" style={{ background: 'var(--panel-surface)' }}>
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: running ? 'var(--accent)' : 'var(--text-tertiary)' }} />
        <span className="text-[13px] font-medium" style={{ color: running ? 'var(--accent)' : 'var(--text-tertiary)' }}>
          {running
            ? `${t('settings.telegramConnected')}${tgStatus?.username ? ` — @${tgStatus.username}` : ''}`
            : t('settings.telegramDisconnected')}
        </span>
      </div>

      {/* Token + Users — one card */}
      <div className="rounded-2xl px-4 py-3" style={{ background: 'var(--panel-surface)' }}>
        <div className="space-y-3">
          {/* Bot Token */}
          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                {t('settings.telegramBotToken')}
              </span>
              <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="opacity-30 hover:opacity-70">
                <ExternalLink size={11} strokeWidth={1.9} style={{ color: 'var(--text-tertiary)' }} />
              </a>
            </div>
            <div className="relative">
              <input
                type={showToken ? 'text' : 'password'}
                value={tgToken}
                onChange={(e) => setTgToken(e.target.value)}
                placeholder={
                  settings.find((s) => s.key === 'telegram.bot_token')?.value && settings.find((s) => s.key === 'telegram.bot_token')?.value !== '••••••••'
                    ? '••••••••' : '123456789:ABC...'
                }
                className="w-full rounded-lg border px-2.5 py-1.5 pr-8 text-[13px] outline-none transition-colors focus:border-[var(--accent)]"
                style={{ background: 'var(--shell-bg)', borderColor: 'var(--border-secondary)', color: 'var(--text-primary)' }}
              />
              <button onClick={() => setShowToken(!showToken)} className="absolute right-2 top-1/2 -translate-y-1/2 opacity-40 hover:opacity-80">
                {showToken ? <EyeOff size={13} style={{ color: 'var(--text-tertiary)' }} /> : <Eye size={13} style={{ color: 'var(--text-tertiary)' }} />}
              </button>
            </div>
          </div>

          {/* Allowed Users */}
          <div>
            <div className="mb-1">
              <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                {t('settings.telegramAllowedUsers')}
              </span>
            </div>
            <input
              type="text"
              value={tgUsers}
              onChange={(e) => setTgUsers(e.target.value)}
              placeholder={settings.find((s) => s.key === 'telegram.allowed_users')?.value || '123456789, 987654321'}
              className="w-full rounded-lg border px-2.5 py-1.5 text-[13px] outline-none transition-colors focus:border-[var(--accent)]"
              style={{ background: 'var(--shell-bg)', borderColor: 'var(--border-secondary)', color: 'var(--text-primary)' }}
            />
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.telegramAllowedUsersDesc')}
            </p>
          </div>
        </div>

        {/* Buttons — inside card */}
        <div className="mt-3 flex justify-end gap-2 border-t pt-3" style={{ borderColor: 'var(--border-secondary)' }}>
          {running && (
            <button
              onClick={handleStop}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
              style={{ background: 'var(--error-soft)', color: 'var(--error)' }}
            >
              {busy ? <Loader2 size={13} strokeWidth={1.9} className="animate-spin" /> : <Power size={13} strokeWidth={1.9} />}
              {t('settings.telegramDisconnect')}
            </button>
          )}
          <button
            onClick={handleConnect}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
          >
            {busy ? <Loader2 size={13} strokeWidth={1.9} className="animate-spin" /> : <Power size={13} strokeWidth={1.9} />}
            {running ? t('settings.telegramRestart') : t('settings.telegramConnect')}
          </button>
        </div>
      </div>
    </>
  );
}
