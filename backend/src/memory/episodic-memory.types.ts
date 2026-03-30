import type { StructuredMemoryProvenance } from './structured-memory-metadata.types';

export type EpisodicMemoryKind = 'goal' | 'constraint' | 'decision' | 'task';

export type EpisodicMemoryEntryRevision = {
  revision: number;
  summary: string;
  salience: number;
  updatedAt: string;
  provenance?: StructuredMemoryProvenance;
};

export type EpisodicMemoryEntry = {
  id: string;
  kind: EpisodicMemoryKind;
  summary: string;
  source: 'explicit_user_statement';
  salience: number;
  pinned?: boolean;
  updatedAt: string;
  provenance?: StructuredMemoryProvenance;
  revision?: number;
  revisionHistory?: EpisodicMemoryEntryRevision[];
};

export const EPISODIC_MEMORY_KIND_ORDER: EpisodicMemoryKind[] = [
  'goal',
  'constraint',
  'decision',
  'task',
];
