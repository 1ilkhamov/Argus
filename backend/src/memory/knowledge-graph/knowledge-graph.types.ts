// ─── Knowledge Graph Node ───────────────────────────────────────────────────

export interface KnowledgeNode {
  id: string;
  type: string;         // file | module | service | api | concept | person | project | tool
  name: string;
  properties: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateKnowledgeNodeParams {
  type: string;
  name: string;
  properties?: Record<string, string>;
}

// ─── Knowledge Graph Edge ───────────────────────────────────────────────────

export type KnowledgeRelation =
  | 'depends_on'
  | 'contains'
  | 'uses'
  | 'implements'
  | 'relates_to'
  | 'created_by'
  | 'modified_by'
  | 'tested_by'
  | 'configures';

export interface KnowledgeEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relation: KnowledgeRelation | string;  // extensible beyond predefined
  weight: number;        // 0.0 – 1.0
  properties?: Record<string, string>;
  createdAt: string;
}

export interface CreateKnowledgeEdgeParams {
  sourceId: string;
  targetId: string;
  relation: string;
  weight?: number;
  properties?: Record<string, string>;
}

// ─── Graph Query ────────────────────────────────────────────────────────────

export interface GraphTraversalParams {
  startNodeId: string;
  maxDepth?: number;      // default 2
  relations?: string[];   // filter by relation type
  limit?: number;         // max nodes to return
}

export interface GraphSearchParams {
  type?: string;
  namePattern?: string;   // substring match
  limit?: number;
}
