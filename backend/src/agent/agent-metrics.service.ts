import { Injectable } from '@nestjs/common';

import { AGENT_MODE_IDS, type AgentModeId } from './modes/mode.types';
import type { AgentUserProfile, AgentUserProfileSource } from './profile/user-profile.types';

const MODE_RESOLUTION_SOURCES = ['explicit', 'inferred'] as const;
const PROFILE_KEY_KINDS = ['local_default'] as const;
const PREFERRED_LANGUAGES = ['auto', 'ru', 'en'] as const;
const TONES = ['direct', 'warm', 'formal'] as const;
const DETAILS = ['adaptive', 'concise', 'detailed'] as const;
const STRUCTURES = ['adaptive', 'structured'] as const;
const TOGGLE_STATES = ['enabled', 'disabled'] as const;
const PROFILE_SOURCES = ['recent_context', 'persisted_profile_and_recent_context'] as const;

type CounterMap<T extends string> = Record<T, number>;
type ToggleState = (typeof TOGGLE_STATES)[number];

export type ModeResolutionSource = (typeof MODE_RESOLUTION_SOURCES)[number];
export type ProfileKeyKind = (typeof PROFILE_KEY_KINDS)[number];

export interface AgentResolutionMetricEvent {
  mode: AgentModeId;
  modeSource: ModeResolutionSource;
  profileSource: AgentUserProfileSource;
  profileKeyKind: ProfileKeyKind;
  userProfile: AgentUserProfile;
}

export interface AgentMetricsSnapshot {
  startedAt: string;
  totalContextResolutions: number;
  mode: {
    byId: CounterMap<AgentModeId>;
    bySource: CounterMap<ModeResolutionSource>;
  };
  profile: {
    bySource: CounterMap<AgentUserProfileSource>;
    byKeyKind: CounterMap<ProfileKeyKind>;
    communication: {
      preferredLanguage: CounterMap<(typeof PREFERRED_LANGUAGES)[number]>;
      tone: CounterMap<(typeof TONES)[number]>;
      detail: CounterMap<(typeof DETAILS)[number]>;
      structure: CounterMap<(typeof STRUCTURES)[number]>;
    };
    interaction: {
      allowPushback: CounterMap<ToggleState>;
      allowProactiveSuggestions: CounterMap<ToggleState>;
    };
  };
}

@Injectable()
export class AgentMetricsService {
  private readonly startedAt = new Date().toISOString();
  private totalContextResolutions = 0;
  private readonly modeById = this.createCounters(AGENT_MODE_IDS);
  private readonly modeBySource = this.createCounters(MODE_RESOLUTION_SOURCES);
  private readonly profileBySource = this.createCounters(PROFILE_SOURCES);
  private readonly profileByKeyKind = this.createCounters(PROFILE_KEY_KINDS);
  private readonly preferredLanguage = this.createCounters(PREFERRED_LANGUAGES);
  private readonly tone = this.createCounters(TONES);
  private readonly detail = this.createCounters(DETAILS);
  private readonly structure = this.createCounters(STRUCTURES);
  private readonly allowPushback = this.createCounters(TOGGLE_STATES);
  private readonly allowProactiveSuggestions = this.createCounters(TOGGLE_STATES);

  recordResolution(event: AgentResolutionMetricEvent): void {
    this.totalContextResolutions += 1;
    this.increment(this.modeById, event.mode);
    this.increment(this.modeBySource, event.modeSource);
    this.increment(this.profileBySource, event.profileSource);
    this.increment(this.profileByKeyKind, event.profileKeyKind);
    this.increment(this.preferredLanguage, event.userProfile.communication.preferredLanguage);
    this.increment(this.tone, event.userProfile.communication.tone);
    this.increment(this.detail, event.userProfile.communication.detail);
    this.increment(this.structure, event.userProfile.communication.structure);
    this.increment(this.allowPushback, this.toToggleState(event.userProfile.interaction.allowPushback));
    this.increment(
      this.allowProactiveSuggestions,
      this.toToggleState(event.userProfile.interaction.allowProactiveSuggestions),
    );
  }

  getSnapshot(): AgentMetricsSnapshot {
    return {
      startedAt: this.startedAt,
      totalContextResolutions: this.totalContextResolutions,
      mode: {
        byId: this.cloneCounters(this.modeById),
        bySource: this.cloneCounters(this.modeBySource),
      },
      profile: {
        bySource: this.cloneCounters(this.profileBySource),
        byKeyKind: this.cloneCounters(this.profileByKeyKind),
        communication: {
          preferredLanguage: this.cloneCounters(this.preferredLanguage),
          tone: this.cloneCounters(this.tone),
          detail: this.cloneCounters(this.detail),
          structure: this.cloneCounters(this.structure),
        },
        interaction: {
          allowPushback: this.cloneCounters(this.allowPushback),
          allowProactiveSuggestions: this.cloneCounters(this.allowProactiveSuggestions),
        },
      },
    };
  }

  private createCounters<T extends string>(keys: readonly T[]): CounterMap<T> {
    return Object.fromEntries(keys.map((key) => [key, 0])) as CounterMap<T>;
  }

  private cloneCounters<T extends string>(counters: CounterMap<T>): CounterMap<T> {
    return { ...counters };
  }

  private increment<T extends string>(counters: CounterMap<T>, key: T): void {
    counters[key] += 1;
  }

  private toToggleState(value: boolean): ToggleState {
    return value ? 'enabled' : 'disabled';
  }
}
