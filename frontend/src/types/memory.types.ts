export type MemoryKind = 'fact' | 'episode' | 'action' | 'learning' | 'skill' | 'preference';
export type MemoryHorizon = 'working' | 'short_term' | 'long_term' | 'archive';

export interface MemoryEntryDto {
  id: string;
  kind: MemoryKind;
  category?: string;
  content: string;
  summary?: string;
  tags: string[];
  source: string;
  horizon: MemoryHorizon;
  importance: number;
  accessCount: number;
  pinned: boolean;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryListResponse {
  entries: MemoryEntryDto[];
  total: number;
}

export interface MemoryStatsResponse {
  total: number;
  facts: number;
  episodes: number;
  actions: number;
  learnings: number;
  skills: number;
  preferences: number;
  pinned: number;
  longTerm: number;
  shortTerm: number;
  working: number;
}
