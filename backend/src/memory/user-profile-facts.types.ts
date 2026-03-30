import type { StructuredMemoryProvenance } from './structured-memory-metadata.types';

export type UserProfileFactKey = 'name' | 'role' | 'project' | 'goal';

export interface UserProfileFactRevision {
  revision: number;
  value: string;
  confidence: number;
  updatedAt: string;
  provenance?: StructuredMemoryProvenance;
}

export interface UserProfileFact {
  key: UserProfileFactKey;
  value: string;
  source: 'explicit_user_statement';
  confidence: number;
  pinned?: boolean;
  updatedAt: string;
  provenance?: StructuredMemoryProvenance;
  revision?: number;
  revisionHistory?: UserProfileFactRevision[];
}

export const USER_PROFILE_FACT_ORDER: UserProfileFactKey[] = ['name', 'role', 'project', 'goal'];
