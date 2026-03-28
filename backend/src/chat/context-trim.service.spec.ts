import { ContextTrimService, _testing } from './context-trim.service';
import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';

const { TRIM_THRESHOLD, KEEP_RECENT_COUNT } = _testing;

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockExtractor = {
  extractFromTurn: jest.fn(),
  reflectOnSession: jest.fn(),
};

const mockCaptureService = {
  captureFromTurn: jest.fn().mockResolvedValue({ created: [], superseded: [], invalidated: [] }),
};

const mockStore = {
  query: jest.fn().mockResolvedValue([]),
};

function createService(): ContextTrimService {
  return new ContextTrimService(
    mockExtractor as any,
    mockCaptureService as any,
    mockStore as any,
  );
}

function makeConversation(messageCount: number): Conversation {
  const messages: Message[] = [];
  for (let i = 0; i < messageCount; i++) {
    messages.push(
      new Message({
        conversationId: 'conv-1',
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message ${i} with unique content about topic ${i} and details ${i * 10}`,
      }),
    );
  }
  return new Conversation({
    id: 'conv-1',
    messages,
  });
}

describe('ContextTrimService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not trim when message count is below threshold', async () => {
    const service = createService();
    const conversation = makeConversation(10);

    const { result } = await service.trimIfNeeded(conversation);

    expect(result.trimmed).toBe(false);
    expect(result.messagesRemoved).toBe(0);
  });

  it('trims when message count exceeds threshold', async () => {
    const service = createService();
    const conversation = makeConversation(TRIM_THRESHOLD + 10);

    const { conversation: trimmed, result } = await service.trimIfNeeded(conversation);

    expect(result.trimmed).toBe(true);
    expect(result.messagesRemoved).toBe(conversation.messageCount - KEEP_RECENT_COUNT);
    expect(result.summaryInjected).toBe(true);

    // New conversation should have summary + kept messages
    expect(trimmed.messageCount).toBe(KEEP_RECENT_COUNT + 1); // +1 for summary
  });

  it('injects summary as first message', async () => {
    const service = createService();
    const conversation = makeConversation(TRIM_THRESHOLD + 10);

    const { conversation: trimmed } = await service.trimIfNeeded(conversation);

    const firstMessage = trimmed.messages[0]!;
    expect(firstMessage.role).toBe('assistant');
    expect(firstMessage.content).toContain('[Context summary:');
    expect(firstMessage.content).toContain('messages trimmed');
  });

  it('calls captureFromTurn for uncovered message pairs', async () => {
    const service = createService();
    const conversation = makeConversation(TRIM_THRESHOLD + 10);

    // No existing entries → all pairs are uncovered
    mockStore.query.mockResolvedValue([]);
    mockCaptureService.captureFromTurn.mockResolvedValue({
      created: [{ id: 'new-1' }],
      superseded: [],
      invalidated: [],
    });

    const { result } = await service.trimIfNeeded(conversation);

    expect(mockCaptureService.captureFromTurn).toHaveBeenCalled();
    expect(result.memoriesExtracted).toBeGreaterThan(0);
  });

  it('skips extraction for pairs already covered by existing memory', async () => {
    const service = createService();
    const conv = makeConversation(TRIM_THRESHOLD + 4);

    // Return entries that cover the first messages' content
    const coveredContent = conv.messages.slice(0, conv.messageCount - KEEP_RECENT_COUNT);
    mockStore.query.mockResolvedValue(
      coveredContent.map((m, i) => ({
        id: `existing-${i}`,
        kind: 'fact',
        content: m.content, // exact match → high coverage
        tags: [],
        source: 'llm_extraction',
        horizon: 'long_term',
        importance: 0.5,
        decayRate: 0,
        accessCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pinned: false,
      })),
    );

    const { result } = await service.trimIfNeeded(conv);

    expect(result.trimmed).toBe(true);
    // Should not call captureFromTurn since content is already covered
    expect(mockCaptureService.captureFromTurn).not.toHaveBeenCalled();
  });

  it('preserves conversation metadata after trim', async () => {
    const service = createService();
    const conversation = makeConversation(TRIM_THRESHOLD + 10);

    const { conversation: trimmed } = await service.trimIfNeeded(conversation);

    expect(trimmed.id).toBe(conversation.id);
    expect(trimmed.scopeKey).toBe(conversation.scopeKey);
    expect(trimmed.title).toBe(conversation.title);
  });

  it('handles extraction failure gracefully', async () => {
    const service = createService();
    const conversation = makeConversation(TRIM_THRESHOLD + 10);

    mockStore.query.mockResolvedValue([]);
    mockCaptureService.captureFromTurn.mockRejectedValue(new Error('LLM timeout'));

    const { result } = await service.trimIfNeeded(conversation);

    // Should still trim despite extraction failure
    expect(result.trimmed).toBe(true);
    expect(result.memoriesExtracted).toBe(0);
  });

  it('includes topic list in summary', async () => {
    const service = createService();
    const conversation = makeConversation(TRIM_THRESHOLD + 10);

    const { conversation: trimmed } = await service.trimIfNeeded(conversation);

    const summary = trimmed.messages[0]!.content;
    expect(summary).toContain('Topics discussed:');
  });

  it('reports extracted count in summary', async () => {
    const service = createService();
    const conversation = makeConversation(TRIM_THRESHOLD + 10);

    mockStore.query.mockResolvedValue([]);
    mockCaptureService.captureFromTurn.mockResolvedValue({
      created: [{ id: 'x1' }, { id: 'x2' }],
      superseded: [],
      invalidated: [],
    });

    const { conversation: trimmed } = await service.trimIfNeeded(conversation);

    const summary = trimmed.messages[0]!.content;
    expect(summary).toContain('new memories extracted');
  });
});
