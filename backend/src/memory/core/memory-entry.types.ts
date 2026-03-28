// ─── Memory Kind ────────────────────────────────────────────────────────────

export type MemoryKind =
  | 'fact'        // факт о пользователе или проекте (имя, стек, конфиг)
  | 'episode'     // что произошло (решение, событие, контекст)
  | 'action'      // что агент сделал (tool call + результат)
  | 'learning'    // вывод/урок (что понял, что не работает)
  | 'skill'       // что агент умеет делать
  | 'preference'  // предпочтение пользователя (стиль, формат, язык)
  | 'identity';   // черта личности агента, выученная из взаимодействий

export const MEMORY_KINDS: readonly MemoryKind[] = [
  'fact',
  'episode',
  'action',
  'learning',
  'skill',
  'preference',
  'identity',
] as const;

// ─── Identity categories ───────────────────────────────────────────────────

export type IdentityCategory =
  | 'personality'    // черты характера (прямолинейный, с юмором, внимательный)
  | 'style'          // стиль общения (краткий, без преамбул, использует аналогии)
  | 'expertise'      // в чём агент силён с этим пользователем
  | 'weakness'       // что не работает, где ошибается
  | 'relationship'   // динамика отношений (юзер ценит pushback, доверяет в архитектуре)
  | 'boundary'       // чего не делать (не извиняться, не использовать emoji)
  | 'value';         // что приоритизировать (accuracy > speed, action > theory)

export const IDENTITY_CATEGORIES: readonly IdentityCategory[] = [
  'personality',
  'style',
  'expertise',
  'weakness',
  'relationship',
  'boundary',
  'value',
] as const;

// ─── Memory Horizon ─────────────────────────────────────────────────────────

export type MemoryHorizon =
  | 'working'      // текущая сессия, живёт до завершения
  | 'short_term'   // дни/недели, затухает через decay
  | 'long_term';   // навсегда, консолидируется

// ─── Memory Source ──────────────────────────────────────────────────────────

export type MemorySource =
  | 'user_explicit'      // пользователь явно сказал / попросил запомнить
  | 'llm_extraction'     // LLM извлёк из разговора автоматически
  | 'agent_reflection'   // агент сам осознал (рефлексия после действий)
  | 'tool_result'        // результат tool call
  | 'consolidation';     // результат слияния нескольких записей

// ─── Provenance ─────────────────────────────────────────────────────────────

export interface MemoryProvenance {
  conversationId?: string;
  messageId?: string;
  toolCallId?: string;
  timestamp: string;
}

// ─── Core MemoryEntry ───────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;

  // Tenant isolation
  scopeKey: string;           // e.g. 'key:<hash>', 'session:<hash>', 'local:default'

  // Что это
  kind: MemoryKind;
  category?: string;          // свободная категория (identity, project, technical, ...)

  // Содержимое
  content: string;            // основной текст
  summary?: string;           // краткое описание для prompt injection
  tags: string[];             // теги для фильтрации и поиска

  // Источник
  source: MemorySource;
  provenance?: MemoryProvenance;

  // Lifecycle
  horizon: MemoryHorizon;
  importance: number;         // 0.0 – 1.0, начальная важность
  decayRate: number;          // скорость затухания (0 = не затухает, 1 = быстро)
  accessCount: number;        // сколько раз recall вернул эту запись
  lastAccessedAt?: string;    // последний recall

  // Время
  createdAt: string;
  updatedAt: string;

  // Управление
  pinned: boolean;            // защищена от decay/pruning
  supersededBy?: string;      // id записи-замены (для противоречий)
  consolidatedFrom?: string[]; // ids записей из которых была слита

  // Embedding
  embeddingId?: string;       // ссылка на вектор в Qdrant
}

// ─── Defaults ───────────────────────────────────────────────────────────────

export const DEFAULT_IMPORTANCE: Record<MemoryKind, number> = {
  fact: 0.7,
  episode: 0.5,
  action: 0.3,
  learning: 0.8,
  skill: 0.9,
  preference: 0.6,
  identity: 0.85,
};

export const DEFAULT_DECAY_RATE: Record<MemoryHorizon, number> = {
  working: 0,      // не затухает (очищается целиком при завершении сессии)
  short_term: 0.05, // медленное затухание
  long_term: 0,     // не затухает
};

export const DEFAULT_HORIZON: Record<MemoryKind, MemoryHorizon> = {
  fact: 'long_term',
  episode: 'short_term',
  action: 'short_term',
  learning: 'long_term',
  skill: 'long_term',
  preference: 'long_term',
  identity: 'long_term',
};

// ─── Create helpers ─────────────────────────────────────────────────────────

export interface CreateMemoryEntryParams {
  kind: MemoryKind;
  content: string;
  source: MemorySource;
  scopeKey?: string;
  category?: string;
  summary?: string;
  tags?: string[];
  horizon?: MemoryHorizon;
  importance?: number;
  provenance?: MemoryProvenance;
  pinned?: boolean;
  consolidatedFrom?: string[];
}

export interface UpdateMemoryEntryParams {
  content?: string;
  summary?: string;
  tags?: string[];
  importance?: number;
  horizon?: MemoryHorizon;
  pinned?: boolean;
  supersededBy?: string;
  embeddingId?: string;
}

// ─── Query / filter ─────────────────────────────────────────────────────────

export interface MemoryQuery {
  scopeKey?: string;
  kinds?: MemoryKind[];
  horizons?: MemoryHorizon[];
  sources?: MemorySource[];
  tags?: string[];             // entries must have ALL these tags
  tagsAny?: string[];          // entries must have ANY of these tags
  category?: string;
  minImportance?: number;
  pinned?: boolean;
  excludeSuperseded?: boolean;
  limit?: number;
  offset?: number;
  orderBy?: 'importance' | 'createdAt' | 'updatedAt' | 'accessCount';
  orderDirection?: 'asc' | 'desc';
}

// ─── Recall confidence ─────────────────────────────────────────────────────

export type RecallConfidence = 'high' | 'medium' | 'low';

// ─── Recall result ──────────────────────────────────────────────────────────

export interface RecalledMemory {
  entry: MemoryEntry;
  score: number;              // 0.0 – 1.0 combined relevance score
  matchSource: 'semantic' | 'keyword' | 'graph' | 'merged';
  confidence: RecallConfidence;    // assigned based on final composite score
  contradicts?: string[];          // IDs of other recalled entries that conflict with this one
}
