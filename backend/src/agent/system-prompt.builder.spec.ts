import { DEFAULT_AGENT_USER_PROFILE } from './profile/user-profile.types';
import { SystemPromptBuilder } from './system-prompt.builder';

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
    expect(prompt).toContain('Match the depth to the user\'s request and avoid unnecessary expansion.');
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

  it('includes structured user facts only when they are explicitly resolved', () => {
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
        userFacts: [
          {
            key: 'name',
            value: 'Alex',
            source: 'explicit_user_statement',
            confidence: 1,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            key: 'project',
            value: 'Argus',
            source: 'explicit_user_statement',
            confidence: 1,
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      },
    );

    expect(prompt).toContain('Known user facts: name=Alex; project=Argus.');
    expect(prompt).toContain(
      'Use known user facts only when they are relevant to the current request. Do not infer additional biography, persistence scope, or hidden context beyond what is explicitly established.',
    );
  });

  it('includes relevant episodic memories when retrieval returns useful prior context', () => {
    const builder = new SystemPromptBuilder();

    const prompt = builder.build(
      'assistant',
      DEFAULT_AGENT_USER_PROFILE,
      {
        episodicMemories: [
          {
            id: 'mem-1',
            kind: 'goal',
            summary: 'ship phase 3 memory retrieval',
            source: 'explicit_user_statement',
            salience: 0.95,
            updatedAt: '2026-02-01T00:00:00.000Z',
          },
          {
            id: 'mem-2',
            kind: 'constraint',
            summary: 'use sqlite before adding vector storage',
            source: 'explicit_user_statement',
            salience: 0.9,
            updatedAt: '2026-02-02T00:00:00.000Z',
          },
        ],
      },
    );

    expect(prompt).toContain(
      'Relevant conversation memory: goal=ship phase 3 memory retrieval; constraint=use sqlite before adding vector storage.',
    );
    expect(prompt).toContain(
      'Use relevant conversation memory only when it materially helps with the current request. Treat it as lightweight prior context, not as a license to invent hidden state or claim more certainty than the stored memory supports.',
    );
  });
});
