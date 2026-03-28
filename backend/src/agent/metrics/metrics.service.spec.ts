import { AgentMetricsService } from './metrics.service';

describe('AgentMetricsService', () => {
  it('records resolution counters across mode, profile, and preference dimensions', () => {
    const service = new AgentMetricsService();

    service.recordResolution({
      mode: 'strategist',
      modeSource: 'explicit',
      profileSource: 'persisted_profile_and_recent_context',
      profileKeyKind: 'local_default',
      userProfile: {
        communication: {
          preferredLanguage: 'ru',
          tone: 'warm',
          detail: 'detailed',
          structure: 'structured',
        },
        interaction: {
          allowPushback: false,
          allowProactiveSuggestions: true,
        },
      },
    });

    const snapshot = service.getSnapshot();

    expect(snapshot.totalContextResolutions).toBe(1);
    expect(snapshot.mode.byId.strategist).toBe(1);
    expect(snapshot.mode.bySource.explicit).toBe(1);
    expect(snapshot.profile.bySource.persisted_profile_and_recent_context).toBe(1);
    expect(snapshot.profile.byKeyKind.local_default).toBe(1);
    expect(snapshot.profile.communication.preferredLanguage.ru).toBe(1);
    expect(snapshot.profile.communication.tone.warm).toBe(1);
    expect(snapshot.profile.communication.detail.detailed).toBe(1);
    expect(snapshot.profile.communication.structure.structured).toBe(1);
    expect(snapshot.profile.interaction.allowPushback.disabled).toBe(1);
    expect(snapshot.profile.interaction.allowProactiveSuggestions.enabled).toBe(1);
  });

  it('returns cloned counters instead of exposing mutable internal state', () => {
    const service = new AgentMetricsService();

    const snapshot = service.getSnapshot();
    snapshot.mode.byId.assistant = 999;

    expect(service.getSnapshot().mode.byId.assistant).toBe(0);
  });
});
