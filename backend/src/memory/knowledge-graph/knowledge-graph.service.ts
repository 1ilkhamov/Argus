import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { LlmService } from '../../llm/llm.service';
import type { LlmMessage } from '../../llm/interfaces/llm.interface';
import { KNOWLEDGE_GRAPH_REPOSITORY, type KnowledgeGraphRepository } from './repositories/knowledge-graph.repository';
import type {
  CreateKnowledgeEdgeParams,
  GraphSearchParams,
  GraphTraversalParams,
  KnowledgeEdge,
  KnowledgeNode,
} from './knowledge-graph.types';

// ─── Entity Extraction Types ─────────────────────────────────────────────────

export interface ExtractedEntity {
  name: string;
  type: string;
}

export interface ExtractedRelation {
  sourceName: string;
  sourceType: string;
  targetName: string;
  targetType: string;
  relation: string;
  weight?: number;
}

export interface GraphExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

// ─── LLM Prompt ──────────────────────────────────────────────────────────────

const ENTITY_EXTRACTION_PROMPT = `You are a knowledge graph entity extractor. Given a memory entry (a fact, episode, or learning from a conversation), extract named entities and their relationships.

Entity types: person, project, service, module, tool, concept, technology, file, api, organization, config, language

Relation types (use the MOST SPECIFIC one that fits):
- uses — A uses B (project uses technology, person uses tool)
- depends_on — A depends on B (service depends on service)
- contains — A contains B (project contains module, module contains file)
- implements — A implements B (service implements api)
- created_by — A was created by B (project created by person)
- configures — A configures B (config configures service)
- tested_by — A is tested by B (module tested by tool)
- modified_by — A was modified by B (file modified by person)
- works_at — person works at organization
- member_of — person is member of team/project
- relates_to — ONLY as last resort when no specific relation above applies

Rules:
- Only extract entities that are EXPLICITLY mentioned (no inference)
- Entity names should be normalized: lowercase, trimmed, no articles
- Each entity must have a type from the list above
- Always prefer a specific relation over "relates_to"
- Weight 0.0–1.0 reflects confidence (default 0.8)
- If nothing is extractable, return empty arrays
- Respond ONLY with valid JSON, no markdown fences

Response format:
{
  "entities": [
    {"name": "nestjs", "type": "technology"},
    {"name": "qdrant", "type": "service"}
  ],
  "relations": [
    {"sourceName": "argus", "sourceType": "project", "targetName": "nestjs", "targetType": "technology", "relation": "uses", "weight": 0.9}
  ]
}`;

const MAX_EXTRACTION_TOKENS = 800;

@Injectable()
export class KnowledgeGraphService {
  private readonly logger = new Logger(KnowledgeGraphService.name);

  constructor(
    @Inject(KNOWLEDGE_GRAPH_REPOSITORY) private readonly repo: KnowledgeGraphRepository,
    @Optional() private readonly llmService?: LlmService,
  ) {}

  // ─── Node Operations ────────────────────────────────────────────────────

  /**
   * Find or create a node by type + name. Returns existing if found.
   */
  async findOrCreateNode(
    type: string,
    name: string,
    properties?: Record<string, string>,
  ): Promise<KnowledgeNode> {
    const normalized = this.normalizeName(name);
    const existing = await this.repo.findNodeByName(type, normalized);
    if (existing) {
      // Merge properties if new ones provided
      if (properties && Object.keys(properties).length > 0) {
        const merged = { ...existing.properties, ...properties };
        await this.repo.updateNode(existing.id, merged);
        return { ...existing, properties: merged, updatedAt: new Date().toISOString() };
      }
      return existing;
    }

    return this.repo.createNode({ type, name: normalized, properties });
  }

  async getNode(id: string): Promise<KnowledgeNode | undefined> {
    return this.repo.getNodeById(id);
  }

  async searchNodes(params: GraphSearchParams): Promise<KnowledgeNode[]> {
    return this.repo.searchNodes(params);
  }

  async deleteNode(id: string): Promise<void> {
    return this.repo.deleteNode(id);
  }

  // ─── Edge Operations ────────────────────────────────────────────────────

  /**
   * Create or strengthen an edge between two nodes.
   * If the edge already exists, its weight is increased (capped at 1.0).
   */
  async addOrStrengthenEdge(params: CreateKnowledgeEdgeParams): Promise<KnowledgeEdge> {
    const existingEdges = await this.repo.getEdgesFrom(params.sourceId, [params.relation]);
    const existing = existingEdges.find((e) => e.targetId === params.targetId);

    if (existing) {
      // Strengthen weight
      const newWeight = Math.min(1.0, existing.weight + 0.1);
      if (newWeight !== existing.weight) {
        // Re-create with higher weight (upsert via ON CONFLICT)
        return this.repo.createEdge({ ...params, weight: newWeight });
      }
      return existing;
    }

    return this.repo.createEdge(params);
  }

  async getEdgesFrom(nodeId: string, relations?: string[]): Promise<KnowledgeEdge[]> {
    return this.repo.getEdgesFrom(nodeId, relations);
  }

  async getEdgesTo(nodeId: string, relations?: string[]): Promise<KnowledgeEdge[]> {
    return this.repo.getEdgesTo(nodeId, relations);
  }

  async deleteEdge(id: string): Promise<void> {
    return this.repo.deleteEdge(id);
  }

  // ─── Traversal ──────────────────────────────────────────────────────────

  async traverse(params: GraphTraversalParams): Promise<KnowledgeNode[]> {
    return this.repo.traverse(params);
  }

  /**
   * Get the full neighborhood of a node: the node itself + neighbors + edges.
   */
  async getNeighborhood(
    nodeId: string,
    maxDepth = 1,
    limit = 20,
  ): Promise<{ center: KnowledgeNode | undefined; neighbors: KnowledgeNode[]; edges: KnowledgeEdge[] }> {
    const [center, neighbors, outEdges, inEdges] = await Promise.all([
      this.repo.getNodeById(nodeId),
      this.repo.traverse({ startNodeId: nodeId, maxDepth, limit }),
      this.repo.getEdgesFrom(nodeId),
      this.repo.getEdgesTo(nodeId),
    ]);

    return {
      center,
      neighbors,
      edges: [...outEdges, ...inEdges],
    };
  }

  // ─── LLM Entity Extraction ─────────────────────────────────────────────

  /**
   * Extract entities and relations from a text using LLM,
   * then upsert them into the knowledge graph.
   */
  async extractAndUpsert(text: string): Promise<{ nodes: KnowledgeNode[]; edges: KnowledgeEdge[] }> {
    const extraction = await this.extractEntities(text);
    if (!extraction || (extraction.entities.length === 0 && extraction.relations.length === 0)) {
      return { nodes: [], edges: [] };
    }

    return this.upsertExtraction(extraction);
  }

  /**
   * Extract entities and relations from text via LLM.
   */
  async extractEntities(text: string): Promise<GraphExtractionResult | undefined> {
    if (!this.llmService) return undefined;
    if (text.trim().length < 10) return undefined;

    try {
      const messages: LlmMessage[] = [
        { role: 'system', content: ENTITY_EXTRACTION_PROMPT },
        { role: 'user', content: `Extract entities and relations from this memory entry:\n\n${text.slice(0, 2000)}` },
      ];

      const result = await this.llmService.complete(messages, {
        maxTokens: MAX_EXTRACTION_TOKENS,
        temperature: 0.1,
      });

      return this.parseExtractionResult(result.content);
    } catch (error) {
      this.logger.warn(`KG entity extraction failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /**
   * Upsert extracted entities and relations into the graph.
   */
  async upsertExtraction(
    extraction: GraphExtractionResult,
  ): Promise<{ nodes: KnowledgeNode[]; edges: KnowledgeEdge[] }> {
    const nodes: KnowledgeNode[] = [];
    const edges: KnowledgeEdge[] = [];

    // Create/find all entities
    const nodeMap = new Map<string, KnowledgeNode>();
    for (const entity of extraction.entities) {
      try {
        const node = await this.findOrCreateNode(entity.type, entity.name);
        nodeMap.set(this.entityKey(entity.type, entity.name), node);
        nodes.push(node);
      } catch (error) {
        this.logger.warn(`Failed to upsert node ${entity.type}:${entity.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Create/strengthen relations
    for (const rel of extraction.relations) {
      try {
        // Ensure both endpoints exist
        const sourceKey = this.entityKey(rel.sourceType, rel.sourceName);
        const targetKey = this.entityKey(rel.targetType, rel.targetName);

        let sourceNode = nodeMap.get(sourceKey);
        if (!sourceNode) {
          sourceNode = await this.findOrCreateNode(rel.sourceType, rel.sourceName);
          nodeMap.set(sourceKey, sourceNode);
          nodes.push(sourceNode);
        }

        let targetNode = nodeMap.get(targetKey);
        if (!targetNode) {
          targetNode = await this.findOrCreateNode(rel.targetType, rel.targetName);
          nodeMap.set(targetKey, targetNode);
          nodes.push(targetNode);
        }

        const edge = await this.addOrStrengthenEdge({
          sourceId: sourceNode.id,
          targetId: targetNode.id,
          relation: rel.relation,
          weight: rel.weight ?? 0.8,
        });
        edges.push(edge);
      } catch (error) {
        this.logger.warn(`Failed to upsert edge ${rel.sourceName}→${rel.targetName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.logger.debug(`KG upsert: ${nodes.length} nodes, ${edges.length} edges`);
    return { nodes, edges };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private normalizeName(name: string): string {
    return name.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  private entityKey(type: string, name: string): string {
    return `${type}:${this.normalizeName(name)}`;
  }

  private parseExtractionResult(raw: string): GraphExtractionResult | undefined {
    try {
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();

      const parsed = JSON.parse(cleaned) as Record<string, unknown>;

      const entities = this.validateEntities(parsed.entities);
      const relations = this.validateRelations(parsed.relations);

      if (entities.length === 0 && relations.length === 0) return undefined;

      return { entities, relations };
    } catch (error) {
      this.logger.warn(`Failed to parse KG extraction: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private validateEntities(raw: unknown): ExtractedEntity[] {
    if (!Array.isArray(raw)) return [];

    return raw
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).name === 'string' &&
        ((item as Record<string, unknown>).name as string).trim().length >= 2 &&
        typeof (item as Record<string, unknown>).type === 'string' &&
        ((item as Record<string, unknown>).type as string).trim().length >= 2,
      )
      .map((item) => ({
        name: (item.name as string).trim(),
        type: (item.type as string).trim().toLowerCase(),
      }));
  }

  private validateRelations(raw: unknown): ExtractedRelation[] {
    if (!Array.isArray(raw)) return [];

    return raw
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).sourceName === 'string' &&
        typeof (item as Record<string, unknown>).sourceType === 'string' &&
        typeof (item as Record<string, unknown>).targetName === 'string' &&
        typeof (item as Record<string, unknown>).targetType === 'string' &&
        typeof (item as Record<string, unknown>).relation === 'string',
      )
      .map((item) => ({
        sourceName: (item.sourceName as string).trim(),
        sourceType: (item.sourceType as string).trim().toLowerCase(),
        targetName: (item.targetName as string).trim(),
        targetType: (item.targetType as string).trim().toLowerCase(),
        relation: (item.relation as string).trim().toLowerCase(),
        weight: typeof item.weight === 'number' && item.weight >= 0 && item.weight <= 1
          ? item.weight
          : undefined,
      }));
  }
}
