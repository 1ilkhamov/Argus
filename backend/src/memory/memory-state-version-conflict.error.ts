export class MemoryStateVersionConflictError extends Error {
  readonly scopeKey: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(scopeKey: string, expectedVersion: number, actualVersion: number) {
    super(
      `Managed memory state version conflict for scope "${scopeKey}": expected ${expectedVersion}, actual ${actualVersion}.`,
    );
    this.name = MemoryStateVersionConflictError.name;
    this.scopeKey = scopeKey;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}
