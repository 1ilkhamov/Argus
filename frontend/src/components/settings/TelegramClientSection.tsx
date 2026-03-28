import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Eye, EyeOff, Loader2, Power, Plus, Trash2, RefreshCw,
  ExternalLink, ChevronDown, ChevronUp, QrCode, Smartphone,
} from 'lucide-react';
import { CustomSelect } from './CustomSelect';
import QRCode from 'qrcode';
import { useLangStore } from '@/stores/ui/lang.store';
import { getTranslation } from '@/i18n';
import { useSettingsStore } from '@/stores/settings/settings.store';
import {
  telegramClientApi,
  type TgClientStatus,
  type TgMonitoredChat,
  type TgDialogInfo,
} from '@/api/resources/telegram-client.api';

const MODE_OPTIONS = ['auto', 'read_only', 'manual', 'disabled'] as const;

export function TelegramClientSection() {
  const { lang } = useLangStore();
  const t = (key: Parameters<typeof getTranslation>[1]) => getTranslation(lang, key);
  const { updateSetting } = useSettingsStore();

  // ─── State ──────────────────────────────────────────────────────────────
  const [status, setStatus] = useState<TgClientStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Auth fields
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [showApiHash, setShowApiHash] = useState(false);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [phoneCodeHash, setPhoneCodeHash] = useState('');
  const [password2fa, setPassword2fa] = useState('');

  // QR auth
  const [authTab, setAuthTab] = useState<'qr' | 'code'>('qr');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [qrLoading, setQrLoading] = useState(false);
  const [qrExpired, setQrExpired] = useState(false);
  const qrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrExpiryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Monitored chats
  const [monitoredChats, setMonitoredChats] = useState<TgMonitoredChat[]>([]);

  // Dialogs
  const [dialogs, setDialogs] = useState<TgDialogInfo[]>([]);
  const [showDialogs, setShowDialogs] = useState(false);
  const [dialogsLoading, setDialogsLoading] = useState(false);

  // ─── Fetch ──────────────────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    try {
      const s = await telegramClientApi.getStatus();
      setStatus(s);
    } catch {
      setStatus(null);
    }
  }, []);

  const fetchChats = useCallback(async () => {
    try {
      const chats = await telegramClientApi.getChats();
      setMonitoredChats(chats);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchChats();
  }, [fetchStatus, fetchChats]);

  // ─── QR cleanup ──────────────────────────────────────────────────────
  const stopQrPolling = useCallback(() => {
    if (qrPollRef.current) { clearInterval(qrPollRef.current); qrPollRef.current = null; }
    if (qrExpiryRef.current) { clearTimeout(qrExpiryRef.current); qrExpiryRef.current = null; }
  }, []);

  useEffect(() => () => stopQrPolling(), [stopQrPolling]);

  // ─── QR auth handler ──────────────────────────────────────────────────
  const handleStartQr = async () => {
    setQrLoading(true);
    setQrExpired(false);
    setError('');
    stopQrPolling();
    try {
      // Save credentials first
      if (apiId.trim()) await updateSetting('telegram_client.api_id', apiId.trim());
      if (apiHash.trim()) await updateSetting('telegram_client.api_hash', apiHash.trim());

      const result = await telegramClientApi.getQrToken();
      if (!result.qrUrl) {
        // Already authorized
        await fetchStatus();
        await fetchChats();
        return;
      }

      // Render QR code to data URL
      const dataUrl = await QRCode.toDataURL(result.qrUrl, {
        width: 256,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
      setQrDataUrl(dataUrl);

      // Set expiry timer
      const expiresMs = Math.max((result.expiresIn - 2) * 1000, 5000);
      qrExpiryRef.current = setTimeout(() => {
        setQrExpired(true);
        stopQrPolling();
      }, expiresMs);

      // Start polling for scan
      qrPollRef.current = setInterval(async () => {
        try {
          const check = await telegramClientApi.checkQrLogin();
          if (check.status === 'authorized') {
            stopQrPolling();
            setQrDataUrl('');
            await fetchStatus();
            await fetchChats();
          } else if (check.status === 'requires_2fa') {
            stopQrPolling();
            setQrDataUrl('');
            await fetchStatus();
          } else if (check.status === 'expired') {
            setQrExpired(true);
            stopQrPolling();
          }
        } catch {
          // ignore poll errors
        }
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setQrLoading(false);
    }
  };

  // ─── Auth handlers ──────────────────────────────────────────────────────
  const handleSendCode = async () => {
    if (!phone.trim()) return;
    setLoading(true);
    setError('');
    try {
      // Save API credentials first
      if (apiId.trim()) await updateSetting('telegram_client.api_id', apiId.trim());
      if (apiHash.trim()) await updateSetting('telegram_client.api_hash', apiHash.trim());

      const result = await telegramClientApi.sendCode(phone.trim());
      setPhoneCodeHash(result.phoneCodeHash);
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSignIn = async () => {
    if (!code.trim()) return;
    setLoading(true);
    setError('');
    try {
      const result = await telegramClientApi.signIn(phone.trim(), code.trim(), phoneCodeHash);
      if (result.requires2FA) {
        await fetchStatus();
      } else if (result.success) {
        setCode('');
        setPhoneCodeHash('');
        await fetchStatus();
        await fetchChats();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleResendCode = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await telegramClientApi.resendCode();
      setPhoneCodeHash(result.phoneCodeHash);
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit2fa = async () => {
    if (!password2fa.trim()) return;
    setLoading(true);
    setError('');
    try {
      await telegramClientApi.submit2fa(password2fa.trim());
      setPassword2fa('');
      await fetchStatus();
      await fetchChats();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    setLoading(true);
    try {
      const s = await telegramClientApi.stop();
      setStatus(s);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const handleRestart = async () => {
    setLoading(true);
    try {
      const s = await telegramClientApi.restart();
      setStatus(s);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  // ─── Dialogs ────────────────────────────────────────────────────────────
  const loadDialogs = async () => {
    setDialogsLoading(true);
    try {
      const d = await telegramClientApi.getDialogs();
      setDialogs(d);
      setShowDialogs(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDialogsLoading(false);
    }
  };

  const addChatFromDialog = async (dialog: TgDialogInfo) => {
    try {
      const chat = await telegramClientApi.addChat({
        chatId: dialog.chatId,
        chatTitle: dialog.title,
        chatType: dialog.type,
        mode: 'auto',
        cooldownSeconds: 30,
      });
      setMonitoredChats((prev) => [chat, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeChat = async (id: string) => {
    try {
      await telegramClientApi.removeChat(id);
      setMonitoredChats((prev) => prev.filter((c) => c.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateChatMode = async (chat: TgMonitoredChat, mode: string) => {
    try {
      const updated = await telegramClientApi.updateChat(chat.id, { mode });
      setMonitoredChats((prev) => prev.map((c) => (c.id === chat.id ? updated : c)));
    } catch {
      // ignore
    }
  };

  // ─── Helpers ────────────────────────────────────────────────────────────
  const isConnected = status?.connected && status.authorized;
  const authStep = status?.authStep ?? 'idle';

  const statusBadge = () => {
    if (isConnected) {
      const label = status?.user
        ? `${t('settings.tgClientConnected')} — ${status.user.firstName}${status.user.username ? ` @${status.user.username}` : ''}`
        : t('settings.tgClientConnected');
      return { bg: 'var(--accent-soft)', color: 'var(--accent)', dot: 'var(--accent)', label };
    }
    if (authStep === 'awaiting_code') {
      return { bg: 'var(--warning-soft, #fef3c7)', color: 'var(--warning, #d97706)', dot: 'var(--warning, #d97706)', label: t('settings.tgClientAwaitingCode') };
    }
    if (authStep === 'awaiting_qr') {
      return { bg: 'var(--warning-soft, #fef3c7)', color: 'var(--warning, #d97706)', dot: 'var(--warning, #d97706)', label: t('settings.tgClientAwaitingQr') };
    }
    if (authStep === 'awaiting_2fa') {
      return { bg: 'var(--warning-soft, #fef3c7)', color: 'var(--warning, #d97706)', dot: 'var(--warning, #d97706)', label: t('settings.tgClientAwaiting2fa') };
    }
    return { bg: 'var(--panel-surface)', color: 'var(--text-tertiary)', dot: 'var(--text-tertiary)', label: t('settings.tgClientDisconnected') };
  };

  const badge = statusBadge();

  const modeLabel = (mode: string) => {
    const map: Record<string, Parameters<typeof getTranslation>[1]> = {
      auto: 'settings.tgClientModeAuto',
      read_only: 'settings.tgClientModeReadOnly',
      manual: 'settings.tgClientModeManual',
      disabled: 'settings.tgClientModeDisabled',
    };
    return t(map[mode] ?? 'settings.tgClientModeAuto');
  };

  const monitoredChatIds = new Set(monitoredChats.map((c) => c.chatId));

  // ─── Render ─────────────────────────────────────────────────────────────
  return (
    <>
      {/* Status row */}
      <div className="flex items-center gap-2 rounded-2xl px-4 py-2.5" style={{ background: 'var(--panel-surface)' }}>
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: badge.dot }} />
        <span className="text-[13px] font-medium" style={{ color: badge.color }}>
          {badge.label}
        </span>
        {isConnected && (
          <div className="ml-auto flex gap-1.5">
            <button
              onClick={handleRestart}
              disabled={loading}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50"
              style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
            >
              {loading ? <Loader2 size={11} strokeWidth={1.9} className="animate-spin" /> : <RefreshCw size={11} strokeWidth={1.9} />}
              {t('settings.tgClientRestart')}
            </button>
            <button
              onClick={handleDisconnect}
              disabled={loading}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50"
              style={{ background: 'var(--error-soft)', color: 'var(--error)' }}
            >
              <Power size={11} strokeWidth={1.9} />
              {t('settings.tgClientDisconnect')}
            </button>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center justify-between rounded-xl px-4 py-2 text-[13px]" style={{ background: 'var(--error-soft)', color: 'var(--error)' }}>
          <span>{error}</span>
          <button onClick={() => setError('')} className="ml-2 opacity-60 hover:opacity-100">✕</button>
        </div>
      )}

      {/* ─── Auth: not connected ─── */}
      {!isConnected && (
        <>
          {/* API Credentials — one card */}
          <div className="rounded-2xl px-4 py-3" style={{ background: 'var(--panel-surface)' }}>
            <div className="space-y-3">
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                    {t('settings.tgClientApiId')}
                  </span>
                  <a href="https://my.telegram.org" target="_blank" rel="noopener noreferrer" className="opacity-30 hover:opacity-70">
                    <ExternalLink size={11} strokeWidth={1.9} style={{ color: 'var(--text-tertiary)' }} />
                  </a>
                </div>
                <input
                  type="text"
                  value={apiId}
                  onChange={(e) => setApiId(e.target.value)}
                  placeholder="12345678"
                  className="w-full rounded-lg border px-2.5 py-1.5 text-[13px] outline-none transition-colors focus:border-[var(--accent)]"
                  style={{ background: 'var(--shell-bg)', borderColor: 'var(--border-secondary)', color: 'var(--text-primary)' }}
                />
              </div>
              <div>
                <div className="mb-1">
                  <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                    {t('settings.tgClientApiHash')}
                  </span>
                </div>
                <div className="relative">
                  <input
                    type={showApiHash ? 'text' : 'password'}
                    value={apiHash}
                    onChange={(e) => setApiHash(e.target.value)}
                    placeholder="0123456789abcdef..."
                    className="w-full rounded-lg border px-2.5 py-1.5 pr-8 text-[13px] outline-none transition-colors focus:border-[var(--accent)]"
                    style={{ background: 'var(--shell-bg)', borderColor: 'var(--border-secondary)', color: 'var(--text-primary)' }}
                  />
                  <button onClick={() => setShowApiHash(!showApiHash)} className="absolute right-2 top-1/2 -translate-y-1/2 opacity-40 hover:opacity-80">
                    {showApiHash ? <EyeOff size={13} style={{ color: 'var(--text-tertiary)' }} /> : <Eye size={13} style={{ color: 'var(--text-tertiary)' }} />}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* 2FA password (shared for both QR and code auth) */}
          {authStep === 'awaiting_2fa' && (
            <div className="rounded-2xl px-4 py-3" style={{ background: 'var(--panel-surface)' }}>
              <div className="mb-1">
                <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  {t('settings.tgClient2fa')}
                </span>
              </div>
              <p className="mb-2 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                {t('settings.tgClient2faDesc')}
              </p>
              <input
                type="password"
                value={password2fa}
                onChange={(e) => setPassword2fa(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-lg border px-2.5 py-1.5 text-[13px] outline-none transition-colors focus:border-[var(--accent)]"
                style={{ background: 'var(--shell-bg)', borderColor: 'var(--border-secondary)', color: 'var(--text-primary)' }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit2fa(); }}
                autoFocus
              />
              <div className="mt-2 flex justify-end">
                <button
                  onClick={handleSubmit2fa}
                  disabled={loading || !password2fa.trim()}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
                  style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                >
                  {loading
                    ? <><Loader2 size={13} strokeWidth={1.9} className="animate-spin" />{t('settings.tgClientSending')}</>
                    : <><Power size={13} strokeWidth={1.9} />{t('settings.tgClientSubmit2fa')}</>}
                </button>
              </div>
            </div>
          )}

          {/* Auth tabs: QR / Code — only show when not in 2FA step */}
          {authStep !== 'awaiting_2fa' && (
            <>
              <div className="flex gap-1 rounded-xl p-1" style={{ background: 'var(--panel-surface)' }}>
                <button
                  onClick={() => setAuthTab('qr')}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors"
                  style={{
                    background: authTab === 'qr' ? 'var(--accent-soft)' : 'transparent',
                    color: authTab === 'qr' ? 'var(--accent)' : 'var(--text-tertiary)',
                  }}
                >
                  <QrCode size={13} strokeWidth={1.9} />
                  {t('settings.tgClientQrTitle')}
                </button>
                <button
                  onClick={() => setAuthTab('code')}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors"
                  style={{
                    background: authTab === 'code' ? 'var(--accent-soft)' : 'transparent',
                    color: authTab === 'code' ? 'var(--accent)' : 'var(--text-tertiary)',
                  }}
                >
                  <Smartphone size={13} strokeWidth={1.9} />
                  {t('settings.tgClientSendCode')}
                </button>
              </div>

              {/* ─── QR Tab ─── */}
              {authTab === 'qr' && (
                <div className="rounded-2xl px-4 py-4" style={{ background: 'var(--panel-surface)' }}>
                  <p className="mb-3 text-center text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                    {t('settings.tgClientQrDesc')}
                  </p>

                  {qrDataUrl && !qrExpired ? (
                    <div className="flex flex-col items-center gap-2">
                      <div className="rounded-xl bg-white p-2">
                        <img src={qrDataUrl} alt="QR" width={180} height={180} />
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                        <Loader2 size={11} strokeWidth={1.9} className="animate-spin" />
                        {t('settings.tgClientQrScanning')}
                      </div>
                    </div>
                  ) : qrExpired ? (
                    <div className="flex flex-col items-center gap-2">
                      <p className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                        {t('settings.tgClientQrExpired')}
                      </p>
                      <button
                        onClick={handleStartQr}
                        disabled={qrLoading || !apiId.trim() || !apiHash.trim()}
                        className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
                        style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                      >
                        {qrLoading ? <Loader2 size={13} strokeWidth={1.9} className="animate-spin" /> : <RefreshCw size={13} strokeWidth={1.9} />}
                        {t('settings.tgClientQrRefresh')}
                      </button>
                    </div>
                  ) : (
                    <div className="flex justify-center">
                      <button
                        onClick={handleStartQr}
                        disabled={qrLoading || !apiId.trim() || !apiHash.trim()}
                        className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
                        style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                      >
                        {qrLoading
                          ? <><Loader2 size={13} strokeWidth={1.9} className="animate-spin" />{t('settings.tgClientSending')}</>
                          : <><QrCode size={13} strokeWidth={1.9} />{t('settings.tgClientQrGenerate')}</>}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* ─── Code Tab ─── */}
              {authTab === 'code' && (
                <div className="rounded-2xl px-4 py-3" style={{ background: 'var(--panel-surface)' }}>
                  {(authStep === 'idle' || authStep === 'awaiting_qr') && (
                    <div className="space-y-2">
                      <div>
                        <div className="mb-1">
                          <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                            {t('settings.tgClientPhone')}
                          </span>
                        </div>
                        <input
                          type="tel"
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                          placeholder={t('settings.tgClientPhonePlaceholder')}
                          className="w-full rounded-lg border px-2.5 py-1.5 text-[13px] outline-none transition-colors focus:border-[var(--accent)]"
                          style={{ background: 'var(--shell-bg)', borderColor: 'var(--border-secondary)', color: 'var(--text-primary)' }}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleSendCode(); }}
                        />
                      </div>
                      <div className="flex justify-end">
                        <button
                          onClick={handleSendCode}
                          disabled={loading || !phone.trim()}
                          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
                          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                        >
                          {loading
                            ? <><Loader2 size={13} strokeWidth={1.9} className="animate-spin" />{t('settings.tgClientSending')}</>
                            : <><Power size={13} strokeWidth={1.9} />{t('settings.tgClientSendCode')}</>}
                        </button>
                      </div>
                    </div>
                  )}

                  {authStep === 'awaiting_code' && (
                    <div className="space-y-2">
                      <div>
                        <div className="mb-1">
                          <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                            {t('settings.tgClientCode')}
                          </span>
                        </div>
                        <input
                          type="text"
                          value={code}
                          onChange={(e) => setCode(e.target.value)}
                          placeholder={t('settings.tgClientCodePlaceholder')}
                          className="w-full rounded-lg border px-2.5 py-1.5 text-[13px] outline-none transition-colors focus:border-[var(--accent)]"
                          style={{ background: 'var(--shell-bg)', borderColor: 'var(--border-secondary)', color: 'var(--text-primary)' }}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleSignIn(); }}
                          autoFocus
                        />
                      </div>
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={handleResendCode}
                          disabled={loading}
                          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
                          style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-secondary)' }}
                        >
                          {loading ? <Loader2 size={12} strokeWidth={1.9} className="animate-spin" /> : <RefreshCw size={12} strokeWidth={1.9} />}
                          SMS
                        </button>
                        <button
                          onClick={handleSignIn}
                          disabled={loading || !code.trim()}
                          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
                          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                        >
                          {loading
                            ? <><Loader2 size={13} strokeWidth={1.9} className="animate-spin" />{t('settings.tgClientSending')}</>
                            : <><Power size={13} strokeWidth={1.9} />{t('settings.tgClientSignIn')}</>}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ─── Connected: Monitored chats ─── */}
      {isConnected && (
        <>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.tgClientMonitoredChats')}
            </span>
            <span className="rounded-md px-1.5 py-0.5 text-[10px] font-medium" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
              {monitoredChats.length}
            </span>
          </div>

          {monitoredChats.length === 0 ? (
            <div className="rounded-2xl px-4 py-3" style={{ background: 'var(--panel-surface)' }}>
              <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                {t('settings.tgClientNoChatsMon')}
              </p>
            </div>
          ) : (
            <div className="rounded-2xl" style={{ background: 'var(--panel-surface)' }}>
              {monitoredChats.map((chat, idx) => (
                <div
                  key={chat.id}
                  className="flex items-center gap-3 px-4 py-2.5"
                  style={{ borderTop: idx > 0 ? '1px solid var(--border-secondary)' : 'none' }}
                >
                  <div className="min-w-0 flex-1">
                    <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                      {chat.chatTitle}
                    </span>
                  </div>
                  <CustomSelect
                    value={chat.mode}
                    options={MODE_OPTIONS}
                    onChange={(val) => updateChatMode(chat, val)}
                    renderLabel={modeLabel}
                  />
                  <button
                    onClick={() => removeChat(chat.id)}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-40 hover:opacity-100"
                    title={t('settings.tgClientRemove')}
                    style={{ color: 'var(--error)' }}
                  >
                    <Trash2 size={12} strokeWidth={1.9} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Dialogs browser */}
          <button
            onClick={() => { if (showDialogs) { setShowDialogs(false); } else { loadDialogs(); } }}
            disabled={dialogsLoading}
            className="flex w-full items-center gap-2 rounded-2xl px-4 py-2.5 text-[13px] font-medium transition-colors disabled:opacity-50"
            style={{ background: 'var(--panel-surface)', color: 'var(--text-primary)' }}
          >
            {dialogsLoading
              ? <Loader2 size={13} strokeWidth={1.9} className="animate-spin" />
              : showDialogs ? <ChevronUp size={13} strokeWidth={1.9} /> : <ChevronDown size={13} strokeWidth={1.9} />}
            {t('settings.tgClientDialogs')}
          </button>

          {showDialogs && dialogs.length > 0 && (
            <div className="max-h-[280px] overflow-y-auto rounded-2xl" style={{ background: 'var(--panel-surface)' }}>
              {dialogs.map((dialog, idx) => {
                const alreadyAdded = monitoredChatIds.has(dialog.chatId);
                return (
                  <div
                    key={dialog.chatId}
                    className="flex items-center gap-2 px-4 py-2"
                    style={{ borderTop: idx > 0 ? '1px solid var(--border-secondary)' : 'none' }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[13px]" style={{ color: 'var(--text-primary)' }}>
                          {dialog.title}
                        </span>
                        <span className="shrink-0 rounded px-1 py-0.5 text-[9px] uppercase" style={{ background: 'var(--shell-bg)', color: 'var(--text-tertiary)' }}>
                          {dialog.type}
                        </span>
                        {dialog.unreadCount > 0 && (
                          <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                            {dialog.unreadCount}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => addChatFromDialog(dialog)}
                      disabled={alreadyAdded}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-20"
                      style={{ background: alreadyAdded ? 'transparent' : 'var(--accent-soft)', color: 'var(--accent)' }}
                      title={alreadyAdded ? 'Already added' : t('settings.tgClientAddChat')}
                    >
                      <Plus size={13} strokeWidth={1.9} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </>
  );
}
