import type { LlmService } from '../../llm/llm.service';
import type { KnowledgeGraphRepository } from './repositories/knowledge-graph.repository';
import type { KnowledgeEdge, KnowledgeNode } from './knowledge-graph.types';
import { KnowledgeGraphService } from './knowledge-graph.service';

const makeNode = (id: string, type: string, name: string): KnowledgeNode => ({
  id,
  type,
  name,
  properties: {},
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
});

const makeEdge = (id: string, sourceId: string, targetId: string, relation: string, weight = 0.8): KnowledgeEdge => ({
  id,
  sourceId,
  targetId,
  relation,
  weight,
  createdAt: '2025-01-01T00:00:00Z',
});

let nodeCounter = 0;
const createMockRepo = () => ({
  createNode: jest.fn().mockImplementation(async (params: { type: string; name: string }) => {
    nodeCounter++;
    return makeNode(`node-${nodeCounter}`, params.type, params.name);
  }),
  getNodeById: jest.fn().mockResolvedValue(undefined),
  findNodeByName: jest.fn().mockResolvedValue(undefined),
  searchNodes: jest.fn().mockResolvedValue([]),
  updateNode: jest.fn().mockResolvedValue(undefined),
  deleteNode: jest.fn().mockResolvedValue(undefined),
  createEdge: jest.fn().mockImplementation(async (params: { sourceId: string; targetId: string; relation: string; weight?: number }) =>
    makeEdge(`edge-${Date.now()}`, params.sourceId, params.targetId, params.relation, params.weight ?? 0.8),
  ),
  getEdgesFrom: jest.fn().mockResolvedValue([]),
  getEdgesTo: jest.fn().mockResolvedValue([]),
  deleteEdge: jest.fn().mockResolvedValue(undefined),
  traverse: jest.fn().mockResolvedValue([]),
}) as unknown as jest.Mocked<KnowledgeGraphRepository>;

const createMockLlm = (response: string) => ({
  complete: jest.fn().mockResolvedValue({ content: response }),
}) as unknown as LlmService;

describe('KnowledgeGraphService', () => {
  beforeEach(() => {
    nodeCounter = 0;
  });

  describe('findOrCreateNode', () => {
    it('creates a new node when not found', async () => {
      const repo = createMockRepo();
      const service = new KnowledgeGraphService(repo);

      const node = await service.findOrCreateNode('technology', 'NestJS');

      expect(node.id).toBe('node-1');
      expect(repo.findNodeByName).toHaveBeenCalledWith('technology', 'nestjs');
      expect(repo.createNode).toHaveBeenCalledWith({ type: 'technology', name: 'nestjs', properties: undefined });
    });

    it('returns existing node when found', async () => {
      const repo = createMockRepo();
      const existing = makeNode('existing-1', 'technology', 'nestjs');
      (repo.findNodeByName as jest.Mock).mockResolvedValue(existing);
      const service = new KnowledgeGraphService(repo);

      const node = await service.findOrCreateNode('technology', 'NestJS');

      expect(node.id).toBe('existing-1');
      expect(repo.createNode).not.toHaveBeenCalled();
    });

    it('merges properties on existing node', async () => {
      const repo = createMockRepo();
      const existing = makeNode('existing-1', 'technology', 'nestjs');
      existing.properties = { version: '10' };
      (repo.findNodeByName as jest.Mock).mockResolvedValue(existing);
      const service = new KnowledgeGraphService(repo);

      const node = await service.findOrCreateNode('technology', 'NestJS', { framework: 'true' });

      expect(repo.updateNode).toHaveBeenCalledWith('existing-1', { version: '10', framework: 'true' });
      expect(node.properties).toEqual({ version: '10', framework: 'true' });
    });

    it('normalizes name to lowercase trimmed', async () => {
      const repo = createMockRepo();
      const service = new KnowledgeGraphService(repo);

      await service.findOrCreateNode('person', '  Alice BOB  ');

      expect(repo.findNodeByName).toHaveBeenCalledWith('person', 'alice bob');
    });
  });

  describe('addOrStrengthenEdge', () => {
    it('creates a new edge when none exists', async () => {
      const repo = createMockRepo();
      const service = new KnowledgeGraphService(repo);

      const edge = await service.addOrStrengthenEdge({
        sourceId: 'n1',
        targetId: 'n2',
        relation: 'uses',
        weight: 0.8,
      });

      expect(edge.sourceId).toBe('n1');
      expect(edge.targetId).toBe('n2');
      expect(edge.relation).toBe('uses');
      expect(repo.createEdge).toHaveBeenCalled();
    });

    it('strengthens existing edge weight', async () => {
      const repo = createMockRepo();
      const existingEdge = makeEdge('e1', 'n1', 'n2', 'uses', 0.7);
      (repo.getEdgesFrom as jest.Mock).mockResolvedValue([existingEdge]);
      const service = new KnowledgeGraphService(repo);

      await service.addOrStrengthenEdge({
        sourceId: 'n1',
        targetId: 'n2',
        relation: 'uses',
        weight: 0.8,
      });

      const callArgs = (repo.createEdge as jest.Mock).mock.calls[0]![0] as { weight: number };
      expect(callArgs.weight).toBeCloseTo(0.8, 5);
    });

    it('caps weight at 1.0', async () => {
      const repo = createMockRepo();
      const existingEdge = makeEdge('e1', 'n1', 'n2', 'uses', 0.95);
      (repo.getEdgesFrom as jest.Mock).mockResolvedValue([existingEdge]);
      const service = new KnowledgeGraphService(repo);

      await service.addOrStrengthenEdge({
        sourceId: 'n1',
        targetId: 'n2',
        relation: 'uses',
      });

      expect(repo.createEdge).toHaveBeenCalledWith(
        expect.objectContaining({ weight: 1.0 }),
      );
    });
  });

  describe('getNeighborhood', () => {
    it('returns center, neighbors, and edges', async () => {
      const repo = createMockRepo();
      const center = makeNode('n1', 'service', 'argus');
      (repo.getNodeById as jest.Mock).mockResolvedValue(center);
      (repo.traverse as jest.Mock).mockResolvedValue([makeNode('n2', 'technology', 'nestjs')]);
      (repo.getEdgesFrom as jest.Mock).mockResolvedValue([makeEdge('e1', 'n1', 'n2', 'uses')]);
      (repo.getEdgesTo as jest.Mock).mockResolvedValue([]);
      const service = new KnowledgeGraphService(repo);

      const result = await service.getNeighborhood('n1');

      expect(result.center).toBeDefined();
      expect(result.center!.id).toBe('n1');
      expect(result.neighbors).toHaveLength(1);
      expect(result.edges).toHaveLength(1);
    });
  });

  describe('extractEntities', () => {
    it('returns undefined when no LLM', async () => {
      const service = new KnowledgeGraphService(createMockRepo());
      const result = await service.extractEntities('some text about NestJS');
      expect(result).toBeUndefined();
    });

    it('returns undefined for short text', async () => {
      const service = new KnowledgeGraphService(createMockRepo(), createMockLlm('{}'));
      const result = await service.extractEntities('short');
      expect(result).toBeUndefined();
    });

    it('extracts entities from LLM response', async () => {
      const llmResponse = JSON.stringify({
        entities: [
          { name: 'nestjs', type: 'technology' },
          { name: 'qdrant', type: 'service' },
        ],
        relations: [
          { sourceName: 'argus', sourceType: 'project', targetName: 'nestjs', targetType: 'technology', relation: 'uses', weight: 0.9 },
        ],
      });
      const service = new KnowledgeGraphService(createMockRepo(), createMockLlm(llmResponse));

      const result = await service.extractEntities('The Argus project uses NestJS framework and Qdrant for vector storage.');

      expect(result).toBeDefined();
      expect(result!.entities).toHaveLength(2);
      expect(result!.relations).toHaveLength(1);
      expect(result!.relations[0]!.relation).toBe('uses');
    });

    it('handles LLM failure gracefully', async () => {
      const llm = { complete: jest.fn().mockRejectedValue(new Error('LLM down')) } as unknown as LlmService;
      const service = new KnowledgeGraphService(createMockRepo(), llm);

      const result = await service.extractEntities('Some meaningful text about technology.');
      expect(result).toBeUndefined();
    });

    it('handles malformed JSON', async () => {
      const service = new KnowledgeGraphService(createMockRepo(), createMockLlm('not json'));
      const result = await service.extractEntities('Some meaningful text about technology.');
      expect(result).toBeUndefined();
    });

    it('handles markdown-fenced JSON', async () => {
      const fenced = '```json\n' + JSON.stringify({
        entities: [{ name: 'typescript', type: 'language' }],
        relations: [],
      }) + '\n```';
      const service = new KnowledgeGraphService(createMockRepo(), createMockLlm(fenced));

      const result = await service.extractEntities('We use TypeScript for all backend development.');
      expect(result).toBeDefined();
      expect(result!.entities).toHaveLength(1);
    });

    it('filters out invalid entities', async () => {
      const llmResponse = JSON.stringify({
        entities: [
          { name: 'nestjs', type: 'technology' },
          { name: '', type: 'technology' },    // empty name
          { name: 'x', type: 'technology' },   // too short
          { name: 'valid', type: '' },          // empty type
          {},                                   // missing fields
        ],
        relations: [],
      });
      const service = new KnowledgeGraphService(createMockRepo(), createMockLlm(llmResponse));

      const result = await service.extractEntities('The project uses NestJS and other technologies.');
      expect(result!.entities).toHaveLength(1);
      expect(result!.entities[0]!.name).toBe('nestjs');
    });
  });

  describe('extractAndUpsert', () => {
    it('creates nodes and edges from LLM extraction', async () => {
      const repo = createMockRepo();
      const llmResponse = JSON.stringify({
        entities: [
          { name: 'argus', type: 'project' },
          { name: 'nestjs', type: 'technology' },
        ],
        relations: [
          { sourceName: 'argus', sourceType: 'project', targetName: 'nestjs', targetType: 'technology', relation: 'uses' },
        ],
      });
      const service = new KnowledgeGraphService(repo, createMockLlm(llmResponse));

      const result = await service.extractAndUpsert('Argus project uses NestJS framework for the backend.');

      expect(result.nodes.length).toBeGreaterThanOrEqual(2);
      expect(result.edges).toHaveLength(1);
      expect(repo.createNode).toHaveBeenCalledTimes(2);
      expect(repo.createEdge).toHaveBeenCalledTimes(1);
    });

    it('returns empty for short text', async () => {
      const service = new KnowledgeGraphService(createMockRepo(), createMockLlm('{}'));
      const result = await service.extractAndUpsert('short');
      expect(result.nodes).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
    });

    it('creates relation endpoints even if not in entities list', async () => {
      const repo = createMockRepo();
      const llmResponse = JSON.stringify({
        entities: [],
        relations: [
          { sourceName: 'argus', sourceType: 'project', targetName: 'nestjs', targetType: 'technology', relation: 'uses' },
        ],
      });
      const service = new KnowledgeGraphService(repo, createMockLlm(llmResponse));

      const result = await service.extractAndUpsert('Argus project uses NestJS framework for the backend.');

      // Both endpoints should be auto-created
      expect(result.nodes).toHaveLength(2);
      expect(result.edges).toHaveLength(1);
    });
  });
});
