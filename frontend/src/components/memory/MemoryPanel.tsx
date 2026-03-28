import { useEffect, useState, useMemo } from 'react';
import { Brain, Pin, PinOff, Trash2, Tag, Target, ShieldCheck, ListChecks, Lightbulb, Plus, Send } from 'lucide-react';
import { useShallow } from 'zustand/shallow';

import { useMemoryStore } from '@/stores/memory/memory.store';
import { useLangStore, type TranslationKey } from '@/stores/ui/lang.store';
import { PageHeader, TabBar, PageSearchBar, PageDivider, PageScrollArea, PageFooter, PageError, PageLoading, PageEmpty } from '@/components/common';
import type { TabItem } from '@/components/common';
import type { MemoryEntryDto, MemoryKind } from '@/types/memory.types';

const CATEGORY_ICONS: Record<string, typeof Target> = {
  goal: Target,
  constraint: ShieldCheck,
  decision: Lightbulb,
  task: ListChecks,
};

const CATEGORY_COLORS: Record<string, string> = {
  goal: 'var(--accent)',
  constraint: '#e67e22',
  decision: '#9b59b6',
  task: '#2ecc71',
};

function MemoryCard({ entry, onPin, onDelete, t }: {
  entry: MemoryEntryDto;
  onPin: (id: string, pinned: boolean) => void;
  onDelete: (id: string) => void;
  t: (key: TranslationKey) => string;
}) {
  const category = entry.category ?? entry.kind;
  const Icon = CATEGORY_ICONS[category] ?? Tag;
  const color = CATEGORY_COLORS[category] ?? 'var(--text-tertiary)';
  const displayText = entry.summary ?? entry.content;

  return (
    <div
      className="surface-card-muted group relative rounded-2xl px-4 py-3 transition-all"
      style={{ border: '1px solid var(--border-secondary)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div
              className="flex h-6 w-6 items-center justify-center rounded-lg"
              style={{ background: `color-mix(in srgb, ${color} 15%, transparent)` }}
            >
              <Icon size={12} style={{ color }} />
            </div>
            <span
              className="rounded-lg px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider"
              style={{
                background: 'var(--accent-soft)',
                color: 'var(--accent)',
              }}
            >
              {category.replace(/_/g, ' ')}
            </span>
            {entry.pinned && (
              <span
                className="flex items-center gap-1 text-[10px] font-medium"
                style={{ color: 'var(--accent)' }}
              >
                <Pin size={10} />
                {t('memory.pinned')}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
            {displayText}
          </p>
          <div className="mt-1 flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            <span>{t('memory.importance')}: {Math.round(entry.importance * 100)}%</span>
            <span>{entry.source.replace(/_/g, ' ')}</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={() => onPin(entry.id, !entry.pinned)}
            className="icon-button flex h-7 w-7 items-center justify-center rounded-lg"
            title={entry.pinned ? t('memory.unpin') : t('memory.pin')}
          >
            {entry.pinned ? <PinOff size={13} /> : <Pin size={13} />}
          </button>
          <button
            onClick={() => {
              if (confirm(t('memory.confirmForget'))) {
                onDelete(entry.id);
              }
            }}
            className="icon-button flex h-7 w-7 items-center justify-center rounded-lg"
            title={t('memory.forget')}
            style={{ color: '#e74c3c' }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

function AddEntryForm({ activeTab, t }: { activeTab: 'facts' | 'episodes'; t: (key: TranslationKey) => string }) {
  const [content, setContent] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const createEntry = useMemoryStore((s) => s.createEntry);

  const handleSubmit = async () => {
    const trimmed = content.trim();
    if (!trimmed) return;
    const kind: MemoryKind = activeTab === 'facts' ? 'fact' : 'episode';
    await createEntry(kind, trimmed);
    setContent('');
    setIsOpen(false);
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="flex w-full items-center justify-center gap-1.5 rounded-xl py-2 text-[12px] font-medium transition-all"
        style={{
          border: '1px dashed var(--border-secondary)',
          color: 'var(--text-tertiary)',
        }}
      >
        <Plus size={13} />
        {t('memory.addEntry')}
      </button>
    );
  }

  return (
    <div
      className="rounded-xl p-2.5"
      style={{ border: '1px solid var(--accent)', background: 'var(--panel-muted)' }}
    >
      <textarea
        autoFocus
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
          if (e.key === 'Escape') { setIsOpen(false); setContent(''); }
        }}
        placeholder={t('memory.addPlaceholder')}
        className="w-full resize-none rounded-lg bg-transparent px-2 py-1.5 text-[13px] outline-none"
        style={{ color: 'var(--text-primary)' }}
        rows={2}
      />
      <div className="mt-1.5 flex justify-end gap-1.5">
        <button
          onClick={() => { setIsOpen(false); setContent(''); }}
          className="rounded-lg px-2.5 py-1 text-[11px] font-medium"
          style={{ color: 'var(--text-tertiary)' }}
        >
          Esc
        </button>
        <button
          onClick={handleSubmit}
          disabled={!content.trim()}
          className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-opacity disabled:opacity-40"
          style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
        >
          <Send size={10} />
          {t('memory.addEntry')}
        </button>
      </div>
    </div>
  );
}

export function MemoryPanel() {
  const { t } = useLangStore();
  const [activeTab, setActiveTab] = useState<'facts' | 'episodes'>('facts');
  const [searchQuery, setSearchQuery] = useState('');

  const {
    facts,
    episodes,
    stats,
    isLoading,
    error,
    loadEntries,
    loadStats,
    deleteEntry,
    pinEntry,
    clearError,
  } = useMemoryStore(
    useShallow((s) => ({
      facts: s.facts,
      episodes: s.episodes,
      stats: s.stats,
      isLoading: s.isLoading,
      error: s.error,
      loadEntries: s.loadEntries,
      loadStats: s.loadStats,
      deleteEntry: s.deleteEntry,
      pinEntry: s.pinEntry,
      clearError: s.clearError,
    })),
  );

  useEffect(() => {
    loadEntries();
    loadStats();
  }, [loadEntries, loadStats]);

  const rawEntries = activeTab === 'facts' ? facts : episodes;
  const emptyLabel = activeTab === 'facts' ? t('memory.noFacts') : t('memory.noEpisodes');

  const filteredEntries = useMemo(() => {
    if (!searchQuery.trim()) return rawEntries;
    const q = searchQuery.toLowerCase();
    return rawEntries.filter((e) =>
      (e.summary ?? e.content).toLowerCase().includes(q) ||
      (e.category ?? '').toLowerCase().includes(q) ||
      e.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  }, [rawEntries, searchQuery]);

  const subtitle = stats
    ? `${t('memory.total')}: ${stats.total} · ${t('memory.pinnedCount')}: ${stats.pinned}`
    : undefined;

  const tabItems: TabItem<'facts' | 'episodes'>[] = [
    { key: 'facts', label: t('memory.facts'), count: facts.length },
    { key: 'episodes', label: t('memory.episodes'), count: episodes.length },
  ];

  return (
    <div className="flex h-full flex-col">
      <PageHeader icon={Brain} title={t('memory.title')} subtitle={subtitle} />
      <PageSearchBar value={searchQuery} onChange={setSearchQuery} placeholder={t('memory.search')} />
      <TabBar tabs={tabItems} activeTab={activeTab} onChange={setActiveTab} variant="pill" />
      <PageDivider />

      {error && <PageError message={error} onDismiss={clearError} dismissLabel={t('common.dismiss')} />}

      <PageScrollArea>
        {isLoading ? (
          <PageLoading label={t('common.loading')} />
        ) : filteredEntries.length === 0 ? (
          <PageEmpty label={searchQuery.trim() ? t('memory.noResults') : emptyLabel} />
        ) : (
          <div className="space-y-2">
            {filteredEntries.map((entry) => (
              <MemoryCard key={entry.id} entry={entry} onPin={pinEntry} onDelete={deleteEntry} t={t} />
            ))}
          </div>
        )}
      </PageScrollArea>

      <PageFooter>
        <AddEntryForm activeTab={activeTab} t={t} />
      </PageFooter>
    </div>
  );
}
