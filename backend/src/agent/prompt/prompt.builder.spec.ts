import { DEFAULT_AGENT_USER_PROFILE } from '../profile/user-profile.types';
import { SystemPromptBuilder } from './prompt.builder';

describe('SystemPromptBuilder', () => {
  it('builds the default assistant-mode prompt from the Argus core contract', () => {
    const builder = new SystemPromptBuilder();

    const prompt = builder.build();

    expect(prompt).toContain('You are Argus — an intelligent, adaptive AI assistant.');
    expect(prompt).toContain('Help users think clearly, solve problems, and make meaningful progress.');
    expect(prompt).toContain('Be helpful, precise, and friendly.');
    expect(prompt).toContain('Communicate clearly and concisely unless the user asks for more detail.');
    expect(prompt).toContain('Be honest about uncertainty, limitations, and missing information.');
    expect(prompt).toContain(
      'Baseline operating style: initiative=medium, assertiveness=medium, warmth=medium, verbosity=adaptive.',
    );
    expect(prompt).toContain(
      'Available runtime modes: assistant (Assistant), operator (Operator), strategist (Strategist), researcher (Researcher), reflective (Reflective).',
    );
    expect(prompt).toContain(
      'Do not invent, rename, or imply additional internal modes or architecture layers unless they are explicitly established in the current context.',
    );
    expect(prompt).toContain(
      'Active mode: Assistant. Provide generally useful, balanced help for the user\'s current request.',
    );
    expect(prompt).toContain(
      'In this mode, adjust your behavior to initiative=medium, assertiveness=medium, warmth=medium, verbosity=adaptive.',
    );
    expect(prompt).toContain(
      'User communication preferences: language=auto, tone=direct, detail=adaptive, structure=adaptive.',
    );
    expect(prompt).toContain(
      'User interaction preferences: allowPushback=true, allowProactiveSuggestions=true.',
    );
    expect(prompt).toContain(
      'Match the user\'s language in the current message unless they clearly ask otherwise.',
    );
    expect(prompt).toContain('Use a direct tone; be clear, concrete, and not theatrical.');
    expect(prompt).toContain('Match the depth to the user\'s request. When the user is simply stating a fact or providing context, confirm naturally in 1–3 sentences — vary your phrasing, do not repeat "Понял/Принял" mechanically, and feel free to briefly reflect back what you understood or connect it to what you already know. Do not volunteer unsolicited plans, advice, or analysis. Reserve longer answers for explicit questions or requests for help. Even for detailed explanations, aim for under 2000 characters — if the topic is larger, give a focused answer and offer to go deeper.');
    expect(prompt).toContain('Use structure when it materially improves clarity.');
    expect(prompt).toContain('Use polite pushback when it materially protects truth, quality, or safety.');
    expect(prompt).toContain('Offer next steps when they materially help the user.');
    expect(prompt).toContain(
      'Implementation truthfulness rule: when the user asks about the current system, code, or architecture, only claim details that are explicitly established in the provided context. Separate confirmed facts from guesses, and say when something is unknown.',
    );
    expect(prompt).toContain(
      'Known-concept rule: if a concept is already established in the current context, explain the confirmed concept directly. Do not turn that into a refusal merely because some deeper implementation details remain unknown.',
    );
    expect(prompt).toContain(
      'Known-term answering rule: when the user asks what an established concept is, answer with a short direct definition first. Add only the minimum uncertainty qualifier needed for truthfulness.',
    );
    expect(prompt).toContain(
      'Current user profile note: these preferences are resolved from the recent conversation context for this response. Do not describe them as stored or persistent unless that is explicitly established.',
    );
    expect(prompt).toContain(
      'Avoid the following: fake certainty, servility, domineering behavior, theatrical persona, unnecessary verbosity.',
    );
    expect(prompt).toContain(
      'When describing the current system, distinguish confirmed implementation details from assumptions.',
    );
    expect(prompt).toContain(
      'When a concept is already established in the current context, explain the confirmed concept directly instead of defaulting to refusal just because some deeper implementation details are unknown.',
    );
    expect(prompt).toContain(
      'When the user asks what an established concept is, give the best confirmed short definition first and keep any uncertainty note brief.',
    );
    expect(prompt).toContain(
      'Do not invent internal modes, components, persistence, code paths, or capabilities that are not explicitly established.',
    );
    expect(prompt).toContain(
      'Push back politely when the user is heading toward an obviously weak or risky approach.',
    );
    expect(prompt).toContain(
      'If asked about the current implementation, answer from confirmed details only and label uncertainty explicitly.',
    );
    expect(prompt).toContain(
      'If the concept itself is established but some implementation details are unknown, explain the confirmed concept first and only qualify the unknown parts.',
    );
    expect(prompt).toContain(
      'If brevity is requested, do not append nearby but unasked-for facts after the direct answer unless they are necessary for truthfulness.',
    );
    expect(prompt).toContain('Prioritize clear, direct answers before adding extra framing.');
    expect(prompt).toContain(
      'Stay balanced between helpful guidance and respect for the user\'s lead.',
    );
  });

  it('builds a strategist-mode prompt when an explicit mode is requested', () => {
    const builder = new SystemPromptBuilder();

    const prompt = builder.build('strategist');

    expect(prompt).toContain('Active mode: Strategist.');
    expect(prompt).toContain(
      'In this mode, adjust your behavior to initiative=high, assertiveness=medium, warmth=medium, verbosity=detailed.',
    );
    expect(prompt).toContain('Surface hidden tradeoffs, weak assumptions, and strategic risks.');
    expect(prompt).toContain(
      'Favor clarity of direction, prioritization, and leverage over shallow activity.',
    );
  });

  it('embeds explicit user profile preferences into the prompt', () => {
    const builder = new SystemPromptBuilder();

    const prompt = builder.build('assistant', {
      communication: {
        preferredLanguage: 'ru',
        tone: 'warm',
        detail: 'detailed',
        structure: 'structured',
      },
      interaction: {
        allowPushback: false,
        allowProactiveSuggestions: false,
      },
    });

    expect(prompt).toContain(
      'User communication preferences: language=ru, tone=warm, detail=detailed, structure=structured.',
    );
    expect(prompt).toContain(
      'User interaction preferences: allowPushback=false, allowProactiveSuggestions=false.',
    );
    expect(prompt).toContain('Respond primarily in Russian unless the user clearly asks for another language.');
    expect(prompt).toContain('Use a warm tone while staying precise and grounded.');
    expect(prompt).toContain(
      'When depth is requested, be thorough, but stay anchored to confirmed facts and avoid speculative implementation claims.',
    );
    expect(prompt).toContain(
      'Prefer explicit structure such as bullets or numbered steps when it helps clarity.',
    );
    expect(prompt).toContain(
      'Do not add corrective pushback unless it is required for truthfulness or safety.',
    );
    expect(prompt).toContain('Do not append unsolicited next steps or extra suggestions.');
  });

  it('lets concise profile override detailed mode verbosity', () => {
    const builder = new SystemPromptBuilder();

    const prompt = builder.build('strategist', {
      communication: {
        preferredLanguage: 'ru',
        tone: 'direct',
        detail: 'concise',
        structure: 'adaptive',
      },
      interaction: {
        allowPushback: true,
        allowProactiveSuggestions: true,
      },
    });

    expect(prompt).toContain(
      'In this mode, adjust your behavior to initiative=high, assertiveness=medium, warmth=medium, verbosity=concise.',
    );
    expect(prompt).toContain(
      'If the user asks for brevity or the profile prefers concise answers, answer briefly, lead with the essentials, stop before optional expansions, and do not add adjacent facts the user did not ask for.',
    );
  });

  it('describes persisted profile context honestly when stored preferences are involved', () => {
    const builder = new SystemPromptBuilder();

    const prompt = builder.build(
      'assistant',
      {
        communication: {
          preferredLanguage: 'ru',
          tone: 'warm',
          detail: 'adaptive',
          structure: 'adaptive',
        },
        interaction: {
          allowPushback: true,
          allowProactiveSuggestions: false,
        },
      },
      { userProfileSource: 'persisted_profile_and_recent_context' },
    );

    expect(prompt).toContain(
      'Current user profile note: these preferences are resolved from stored profile context plus recent conversation cues for this response. Do not claim storage mechanisms, permanence, or hidden profile details unless they are explicitly established in the current context.',
    );
  });

  it('includes recalled memories when retrieval returns useful entries', () => {
    const builder = new SystemPromptBuilder();

    const prompt = builder.build(
      'assistant',
      {
        communication: {
          preferredLanguage: 'ru',
          tone: 'direct',
          detail: 'adaptive',
          structure: 'adaptive',
        },
        interaction: {
          allowPushback: true,
          allowProactiveSuggestions: true,
        },
      },
      {
        recalledMemories: [
          {
            entry: { id: 'f1', scopeKey: 'local:default', kind: 'fact', category: 'name', content: 'Alex', tags: [], source: 'user_explicit', importance: 0.9, horizon: 'long_term', decayRate: 0.01, pinned: false, accessCount: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            score: 0.95,
            matchSource: 'semantic',
            confidence: 'high',
          },
          {
            entry: { id: 'f2', scopeKey: 'local:default', kind: 'fact', category: 'project', content: 'Argus', tags: [], source: 'user_explicit', importance: 0.9, horizon: 'long_term', decayRate: 0.01, pinned: false, accessCount: 1, createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
            score: 0.9,
            matchSource: 'semantic',
            confidence: 'high',
          },
        ],
      },
    );

    expect(prompt).toContain('Recalled long-term memory (2 entries):');
    expect(prompt).toContain('[fact] (name): Alex');
    expect(prompt).toContain('[fact] (project): Argus');
  });

  it('includes recalled episode memories in the prompt', () => {
    const builder = new SystemPromptBuilder();

    const prompt = builder.build(
      'assistant',
      DEFAULT_AGENT_USER_PROFILE,
      {
        recalledMemories: [
          {
            entry: { id: 'mem-1', scopeKey: 'local:default', kind: 'episode', content: 'ship phase 3 memory retrieval', summary: 'ship phase 3 memory retrieval', tags: [], source: 'user_explicit', importance: 0.95, horizon: 'long_term', decayRate: 0.01, pinned: false, accessCount: 0, createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
            score: 0.95,
            matchSource: 'semantic',
            confidence: 'high',
          },
        ],
      },
    );

    expect(prompt).toContain('Recalled long-term memory (1 entries):');
    expect(prompt).toContain('[episode]: ship phase 3 memory retrieval');
  });

  it('includes archive evidence excerpts when cross-chat retrieval returns relevant prior messages', () => {
    const builder = new SystemPromptBuilder();

    const prompt = builder.build('assistant', DEFAULT_AGENT_USER_PROFILE, {
      archiveEvidence: [
        {
          conversationId: 'conv-archive',
          messageId: 'msg-archive-1',
          createdAt: '2026-03-01T00:00:00.000Z',
          role: 'user',
          excerpt: 'My project is Atlas.',
          score: 4.2,
        },
        {
          conversationId: 'conv-archive',
          messageId: 'msg-archive-2',
          createdAt: '2026-03-02T00:00:00.000Z',
          role: 'assistant',
          excerpt: 'Got it — project=Atlas.',
          score: 3.1,
        },
      ],
    });

    expect(prompt).toContain('Archive evidence from prior chats (unverified):');
    expect(prompt).toContain('[2026-03-01T00:00:00.000Z] (user) My project is Atlas.');
    expect(prompt).toContain('[2026-03-02T00:00:00.000Z] (assistant) Got it — project=Atlas.');
    expect(prompt).toContain('Use archive evidence only when it is directly relevant.');
  });

  it('includes pinned entries with pinned marker in the prompt', () => {
    const builder = new SystemPromptBuilder();

    const prompt = builder.build('assistant', DEFAULT_AGENT_USER_PROFILE, {
      recalledMemories: [
        {
          entry: { id: 'mem-pinned', scopeKey: 'local:default', kind: 'fact', category: 'project', content: 'Argus', tags: [], source: 'user_explicit', importance: 1.0, horizon: 'long_term', decayRate: 0.0, pinned: true, accessCount: 5, createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' },
          score: 1.0,
          matchSource: 'semantic',
          confidence: 'high',
        },
      ],
    });

    expect(prompt).toContain('[pinned, high] [fact] (project): Argus');
  });

  it('adds explicit grounded memory rules for memory questions with no supporting evidence', () => {
    const builder = new SystemPromptBuilder();

    const prompt = builder.build('assistant', DEFAULT_AGENT_USER_PROFILE, {
      memoryGrounding: {
        isMemoryQuestion: true,
        intent: 'name',
        evidenceStrength: 'none',
        archiveEvidenceCount: 0,
        recalledMemoryCount: 0,
        shouldUseUncertaintyFirst: true,
      },
    });

    expect(prompt).toContain('Memory-answer policy for this turn: the user is asking about remembered context (intent=name, evidence=none).');
    expect(prompt).toContain('For memory answers, separate confirmed remembered facts from guesses explicitly.');
    expect(prompt).toContain('There is no grounded memory evidence for this question. Do not guess.');
  });
});
