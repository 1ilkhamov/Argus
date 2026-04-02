import { Injectable } from '@nestjs/common';

import type { TurnResolutionDiagnostics } from './turn-resolution-diagnostics.types';

const MAX_DIAGNOSTIC_HISTORY = 25;

@Injectable()
export class TurnResolutionDiagnosticsService {
  private readonly recent: TurnResolutionDiagnostics[] = [];

  record(snapshot: TurnResolutionDiagnostics): void {
    this.recent.unshift(snapshot);
    if (this.recent.length > MAX_DIAGNOSTIC_HISTORY) {
      this.recent.length = MAX_DIAGNOSTIC_HISTORY;
    }
  }

  getLatest(): TurnResolutionDiagnostics | undefined {
    return this.recent[0];
  }

  listRecent(limit = 10): TurnResolutionDiagnostics[] {
    return this.recent.slice(0, Math.max(1, limit));
  }
}
