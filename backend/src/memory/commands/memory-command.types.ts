/**
 * MemoryCommand — typed intermediate model (ADT) for the memory command pipeline.
 *
 * Pipeline: text → MemoryCommand[] → execute(command) → OperationNote
 *
 * Each variant is a fully self-contained instruction that the executor can
 * dispatch without re-parsing or guessing intent.
 */
// Inlined from legacy types (previously in episodic/user-facts modules)
export type UserProfileFactKey = 'name' | 'role' | 'project' | 'goal' | 'stack';
export type EpisodicMemoryKind = 'goal' | 'constraint' | 'decision' | 'background' | 'task' | 'working_context';
export const USER_PROFILE_FACT_ORDER: UserProfileFactKey[] = ['name', 'role', 'project', 'goal', 'stack'];

/* ------------------------------------------------------------------ */
/*  ADT variants                                                      */
/* ------------------------------------------------------------------ */

export interface InspectCommand {
  readonly action: 'inspect';
}

export interface ForgetFactCommand {
  readonly action: 'forget_fact';
  readonly key: UserProfileFactKey;
  readonly expectedValue?: string;
}

export interface PinFactCommand {
  readonly action: 'pin_fact';
  readonly key: UserProfileFactKey;
}

export interface UnpinFactCommand {
  readonly action: 'unpin_fact';
  readonly key: UserProfileFactKey;
}

export interface ForgetEpisodicCommand {
  readonly action: 'forget_episodic';
  readonly kind: EpisodicMemoryKind;
  readonly selectorText: string;
}

export interface PinEpisodicCommand {
  readonly action: 'pin_episodic';
  readonly kind: EpisodicMemoryKind;
  readonly selectorText: string;
}

export interface UnpinEpisodicCommand {
  readonly action: 'unpin_episodic';
  readonly kind: EpisodicMemoryKind;
  readonly selectorText: string;
}

/* ------------------------------------------------------------------ */
/*  Union type                                                        */
/* ------------------------------------------------------------------ */

export type MemoryCommand =
  | InspectCommand
  | ForgetFactCommand
  | PinFactCommand
  | UnpinFactCommand
  | ForgetEpisodicCommand
  | PinEpisodicCommand
  | UnpinEpisodicCommand;

/* ------------------------------------------------------------------ */
/*  Derived action groups                                             */
/* ------------------------------------------------------------------ */

export type FactCommand = ForgetFactCommand | PinFactCommand | UnpinFactCommand;
export type EpisodicCommand = ForgetEpisodicCommand | PinEpisodicCommand | UnpinEpisodicCommand;
export type FactAction = FactCommand['action'];
export type EpisodicAction = EpisodicCommand['action'];

/* ------------------------------------------------------------------ */
/*  Type guards                                                       */
/* ------------------------------------------------------------------ */

export function isFactCommand(command: MemoryCommand): command is FactCommand {
  return 'key' in command;
}

export function isEpisodicCommand(command: MemoryCommand): command is EpisodicCommand {
  return 'kind' in command;
}

export function isInspectCommand(command: MemoryCommand): command is InspectCommand {
  return command.action === 'inspect';
}
