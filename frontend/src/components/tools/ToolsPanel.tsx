import { useEffect, useState, useMemo } from 'react';
import { Wrench, Globe, Brain, Terminal, Clock, FileText, Cpu, ShieldCheck, ShieldAlert, Shield, Calendar } from 'lucide-react';
import { useShallow } from 'zustand/shallow';

import { useToolsStore } from '@/stores/tools/tools.store';
import { useLangStore, type TranslationKey } from '@/stores/ui/lang.store';
import { PageHeader, PageSearchBar, PageDivider, PageScrollArea, PageError, PageLoading, PageEmpty } from '@/components/common';
import type { ToolInfoDto } from '@/types/tools.types';

const TOOL_ICONS: Record<string, typeof Globe> = {
  web_search: Globe,
  web_fetch: Globe,
  http_request: Globe,
  browser: Globe,
  memory_manage: Brain,
  knowledge_search: Brain,
  system_run: Terminal,
  file_ops: FileText,
  clipboard: FileText,
  pdf_read: FileText,
  calculator: Cpu,
  code_exec: Cpu,
  datetime: Clock,
  audio_transcribe: Cpu,
  cron: Calendar,
  notify: ShieldCheck,
  vision: Cpu,
};

const TOOL_CATEGORIES: Record<string, string[]> = {
  web: ['web_search', 'web_fetch', 'http_request', 'browser'],
  memory: ['memory_manage', 'knowledge_search'],
  system: ['system_run', 'file_ops', 'clipboard', 'notify', 'vision', 'pdf_read'],
  compute: ['calculator', 'code_exec', 'datetime', 'audio_transcribe'],
  scheduling: ['cron'],
};

const SAFETY_COLORS: Record<string, string> = {
  safe: '#22c55e',
  moderate: '#f59e0b',
  dangerous: '#ef4444',
};

function SafetyBadge({ safety, t }: { safety: string; t: (key: TranslationKey) => string }) {
  const color = SAFETY_COLORS[safety] ?? 'var(--text-tertiary)';
  const label = t(`tools.${safety}` as TranslationKey);
  const Icon = safety === 'dangerous' ? ShieldAlert : safety === 'moderate' ? Shield : ShieldCheck;

  return (
    <span
      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
      style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color }}
    >
      <Icon size={10} />
      {label}
    </span>
  );
}

function ToolCard({ tool, t }: { tool: ToolInfoDto; t: (key: TranslationKey) => string }) {
  const Icon = TOOL_ICONS[tool.name] ?? Wrench;
  const [expanded, setExpanded] = useState(false);
  const descKey = `tools.desc_${tool.name}` as TranslationKey;
  const translated = t(descKey);
  const description = translated !== descKey ? translated : tool.description;

  return (
    <div
      className="surface-card-muted cursor-pointer rounded-2xl px-4 py-3 transition-all hover:brightness-105"
      style={{ border: '1px solid var(--border-secondary)' }}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div
              className="flex h-7 w-7 items-center justify-center rounded-lg"
              style={{ background: 'var(--accent-soft)' }}
            >
              <Icon size={14} style={{ color: 'var(--accent)' }} />
            </div>
            <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {tool.name}
            </span>
            <SafetyBadge safety={tool.safety} t={t} />
          </div>
          <p
            className="mt-1.5 text-[12px] leading-relaxed"
            style={{
              color: 'var(--text-secondary)',
              display: expanded ? 'block' : '-webkit-box',
              WebkitLineClamp: expanded ? undefined : 2,
              WebkitBoxOrient: 'vertical',
              overflow: expanded ? 'visible' : 'hidden',
            }}
          >
            {description}
          </p>

          {expanded && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              {tool.timeoutMs && (
                <span className="flex items-center gap-1">
                  <Clock size={10} />
                  {t('tools.timeout')}: {(tool.timeoutMs / 1000).toFixed(0)}s
                </span>
              )}
              {tool.parameters.length > 0 && (
                <span>
                  {t('tools.params')}: {tool.parameters.join(', ')}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function getCategoryForTool(name: string): string {
  for (const [cat, names] of Object.entries(TOOL_CATEGORIES)) {
    if (names.includes(name)) return cat;
  }
  return 'other';
}

const CATEGORY_LABELS: Record<string, Record<string, string>> = {
  web: { en: 'Web', ru: 'Интернет' },
  memory: { en: 'Memory', ru: 'Память' },
  system: { en: 'System', ru: 'Система' },
  compute: { en: 'Compute', ru: 'Вычисления' },
  scheduling: { en: 'Scheduling', ru: 'Расписание' },
  other: { en: 'Other', ru: 'Прочее' },
};

export function ToolsPanel() {
  const { t } = useLangStore();
  const lang = useLangStore((s) => s.lang);
  const [searchQuery, setSearchQuery] = useState('');

  const { tools, isLoading, error, loadTools, clearError } = useToolsStore(
    useShallow((s) => ({
      tools: s.tools,
      isLoading: s.isLoading,
      error: s.error,
      loadTools: s.loadTools,
      clearError: s.clearError,
    })),
  );

  useEffect(() => {
    loadTools();
  }, [loadTools]);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return tools;
    const q = searchQuery.toLowerCase();
    return tools.filter(
      (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
    );
  }, [tools, searchQuery]);

  const grouped = useMemo(() => {
    const groups: Record<string, ToolInfoDto[]> = {};
    for (const tool of filtered) {
      const cat = getCategoryForTool(tool.name);
      (groups[cat] ??= []).push(tool);
    }
    return groups;
  }, [filtered]);

  const categoryOrder = ['web', 'memory', 'system', 'compute', 'scheduling', 'other'];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={Wrench}
        title={t('tools.title')}
        subtitle={`${t('tools.count')}: ${tools.length}`}
      />
      <PageSearchBar value={searchQuery} onChange={setSearchQuery} placeholder={t('tools.searchPlaceholder')} />
      <PageDivider />

      {error && <PageError message={error} onDismiss={clearError} dismissLabel={t('common.dismiss')} />}

      <PageScrollArea>
        {isLoading ? (
          <PageLoading label={t('common.loading')} />
        ) : filtered.length === 0 ? (
          <PageEmpty label={t('tools.noTools')} />
        ) : (
          <div className="space-y-4">
            {categoryOrder
              .filter((cat) => grouped[cat]?.length)
              .map((cat) => (
                <div key={cat}>
                  <h3
                    className="mb-2 text-[11px] font-semibold uppercase tracking-wider"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    {CATEGORY_LABELS[cat]?.[lang] ?? cat}
                  </h3>
                  <div className="space-y-2">
                    {grouped[cat]!.map((tool) => (
                      <ToolCard key={tool.name} tool={tool} t={t} />
                    ))}
                  </div>
                </div>
              ))}
          </div>
        )}
      </PageScrollArea>
    </div>
  );
}
