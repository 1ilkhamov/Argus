import type {
  CreateKnowledgeEdgeParams,
  CreateKnowledgeNodeParams,
  GraphSearchParams,
  GraphTraversalParams,
  KnowledgeEdge,
  KnowledgeNode,
} from '../knowledge-graph.types';

export const KNOWLEDGE_GRAPH_REPOSITORY = Symbol('KNOWLEDGE_GRAPH_REPOSITORY');

export abstract class KnowledgeGraphRepository {
  abstract createNode(params: CreateKnowledgeNodeParams): Promise<KnowledgeNode>;
  abstract getNodeById(id: string): Promise<KnowledgeNode | undefined>;
  abstract findNodeByName(type: string, name: string): Promise<KnowledgeNode | undefined>;
  abstract searchNodes(params: GraphSearchParams): Promise<KnowledgeNode[]>;
  abstract updateNode(id: string, properties: Record<string, string>): Promise<void>;
  abstract deleteNode(id: string): Promise<void>;

  abstract createEdge(params: CreateKnowledgeEdgeParams): Promise<KnowledgeEdge>;
  abstract getEdgesFrom(nodeId: string, relations?: string[]): Promise<KnowledgeEdge[]>;
  abstract getEdgesTo(nodeId: string, relations?: string[]): Promise<KnowledgeEdge[]>;
  abstract deleteEdge(id: string): Promise<void>;

  abstract traverse(params: GraphTraversalParams): Promise<KnowledgeNode[]>;
}
