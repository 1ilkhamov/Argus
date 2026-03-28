/**
 * Pure parsing functions extracted from ConversationalMemoryCommandService.
 *
 * Every function here is side-effect-free: text in → typed commands out.
 * The service remains the orchestrator; this module is the detection/extraction layer.
 */
import type { EpisodicMemoryKind } from './memory-command.types';
import type { UserProfileFactKey } from './memory-command.types';
import {
  isMemoryInspectCommand,
  MEMORY_COMMAND_SPLIT,
  startsWithDeterministicMemoryCommand,
  startsWithMemoryForgetVerb,
  startsWithMemoryPinVerb,
  startsWithMemoryUnpinVerb,
} from './command.matchers';
import { tokenize } from './command.selector';
import { isFactCommand, type MemoryCommand } from './memory-command.types';

/* ------------------------------------------------------------------ */
/*  Re-exports for backward compatibility                             */
/* ------------------------------------------------------------------ */

export type { FactAction, EpisodicAction, MemoryCommand } from './memory-command.types';
export { isFactCommand, isEpisodicCommand, isInspectCommand } from './memory-command.types';
export type ParsedMemoryCommand = MemoryCommand;

/* ------------------------------------------------------------------ */
/*  Main entry point                                                  */
/* ------------------------------------------------------------------ */

export function parseCommands(content: string): MemoryCommand[] {
  // Fast path: if message starts with a command verb, parse normally
  // Slow path: split into clauses and check each one for embedded commands
  if (!startsWithDeterministicMemoryCommand(content) && !containsMemoryCommandAnywhere(content)) {
    return [];
  }

  const clauses = splitIntoClauses(content);
  const parsedCommands = clauses
    .map((clause) => parseClause(clause))
    .filter((command): command is ParsedMemoryCommand => Boolean(command));

  if (parsedCommands.length === 0 && isMemoryInspectCommand(content)) {
    return [{ action: 'inspect' }];
  }

  if (
    parsedCommands.length > 0 &&
    !parsedCommands.some((command) => command.action === 'inspect') &&
    containsInspectClause(content)
  ) {
    parsedCommands.push({ action: 'inspect' });
  }

  return parsedCommands.filter(
    (command, index, commands) =>
      commands.findIndex((candidate) => toCommandKey(candidate) === toCommandKey(command)) === index,
  );
}

/* ------------------------------------------------------------------ */
/*  Clause splitting                                                  */
/* ------------------------------------------------------------------ */

export function splitIntoClauses(content: string): string[] {
  return content
    .split(MEMORY_COMMAND_SPLIT)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

/* ------------------------------------------------------------------ */
/*  Clause parsing                                                    */
/* ------------------------------------------------------------------ */

export function parseClause(clause: string): MemoryCommand | undefined {
  if (isMemoryInspectCommand(clause)) {
    return { action: 'inspect' };
  }

  if (startsWithMemoryForgetVerb(clause)) {
    return parseMutationClause(clause, 'forget_fact');
  }

  if (startsWithMemoryUnpinVerb(clause)) {
    return parseMutationClause(clause, 'unpin');
  }

  if (startsWithMemoryPinVerb(clause)) {
    return parseMutationClause(clause, 'pin');
  }

  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Mutation clause parsing                                           */
/* ------------------------------------------------------------------ */

export function parseMutationClause(
  clause: string,
  action: 'forget_fact' | 'pin' | 'unpin',
): MemoryCommand | undefined {
  const episodicKind = extractEpisodicKind(clause);
  if (episodicKind) {
    if (action === 'forget_fact') {
      return {
        action: 'forget_episodic',
        kind: episodicKind,
        selectorText: clause,
      };
    }

    return {
      action: action === 'pin' ? 'pin_episodic' : 'unpin_episodic',
      kind: episodicKind,
      selectorText: clause,
    };
  }

  const factKey = extractFactKey(clause);

  // Content-based fallback: when verb is recognized but no key matches,
  // extract the target text and use it as expectedValue for content search
  if (!factKey) {
    const contentQuery = extractContentQuery(clause);
    if (!contentQuery) return undefined;
    if (action === 'forget_fact') {
      return { action: 'forget_fact', key: 'name', expectedValue: contentQuery };
    }
    // For pin/unpin without key, we cannot resolve — fall through to undefined
    return undefined;
  }

  if (factKey === 'goal' && action !== 'forget_fact') {
    return {
      action: action === 'pin' ? 'pin_episodic' : 'unpin_episodic',
      kind: 'goal',
      selectorText: clause,
    };
  }

  return {
    action: action === 'pin' ? 'pin_fact' : action === 'unpin' ? 'unpin_fact' : 'forget_fact',
    key: factKey,
    expectedValue: action === 'forget_fact' ? extractExpectedFactValue(clause, factKey) : undefined,
  };
}

/**
 * Extract content query from a clause when no structured key was found.
 * Used for content-based forget: "забудь про Python" → "Python"
 */
export function extractContentQuery(clause: string): string | undefined {
  const cleaned = clause
    .replace(/^\s*(?:forget|delete|remove|забудь|удали)\s*/iu, '')
    .replace(/^\s*(?:про|about|that|что|мой|мою|моё|мои|my|the|this|это|этот|факт|fact|memory|запись)\s*/giu, '')
    .replace(/[.!?;,]+$/g, '')
    .trim();
  return cleaned.length >= 2 ? cleaned : undefined;
}

/* ------------------------------------------------------------------ */
/*  Detection / extraction                                            */
/* ------------------------------------------------------------------ */

export function extractFactKey(content: string): UserProfileFactKey | undefined {
  if (/\bname\b|имя/i.test(content)) {
    return 'name';
  }
  if (/\brole\b|роль/i.test(content)) {
    return 'role';
  }
  if (/\bproject\b|проект/i.test(content)) {
    return 'project';
  }
  if (/\bgoal\b|цель/i.test(content)) {
    return 'goal';
  }
  if (/\bstack\b|стек|технолог/i.test(content)) {
    return 'stack';
  }

  return undefined;
}

export function extractEpisodicKind(content: string): EpisodicMemoryKind | undefined {
  if (/\bconstraint\b|ограничен/i.test(content)) {
    return 'constraint';
  }
  if (/\bdecision\b|решени/i.test(content)) {
    return 'decision';
  }
  if (/\btask\b|задач/i.test(content)) {
    return 'task';
  }
  if (/\bgoal\b|цель/i.test(content) && /\b(?:current|latest|that|memor(?:y|ies)|all)\b|текущ|последн|памят|все/i.test(content)) {
    return 'goal';
  }

  return undefined;
}

export function extractExpectedFactValue(content: string, key: UserProfileFactKey): string | undefined {
  if (key !== 'project') {
    return undefined;
  }

  const patterns = [
    /(?:стар(?:ое|ый|ую)?|предыдущ(?:ий|ее|ую)|legacy|previous|old)\s+(?:название\s+)?(?:проекта|project(?:\s+name)?)\s+([^,.!?;:]+(?:\s+[^,.!?;:]+){0,7})/iu,
    /(?:название\s+проекта|project\s+name)\s+([^,.!?;:]+(?:\s+[^,.!?;:]+){0,7})/iu,
    /(?:\bproject\b|проект)\s+([^,.!?;:]+(?:\s+[^,.!?;:]+){0,7})/iu,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(content);
    const normalized = normalizeTargetValue(match?.[1]);
    if (normalized && normalized !== 'project' && normalized !== 'проект') {
      return normalized;
    }
  }

  return undefined;
}

export function normalizeTargetValue(value: string | undefined): string | undefined {
  const normalized = value
    ?.replace(/^(?:named|called|fact|memory|мой|моя|моё|мои|my|the|old|new|стар(?:ый|ое|ую)?|нов(?:ый|ое|ую)?|stored|current|текущ(?:ий|ая|ее|ую))\s+/iu, '')
    .replace(/^(?:legacy|previous|предыдущ(?:ий|ее|ую)|название|name)\s+/iu, '')
    .replace(/^(?:project|проект)\s+/iu, '')
    .replace(/\s*,\s*(?:не трогай|don't touch|но|but)\b.*$/iu, '')
    .replace(
      /\s+(?:and|и)\s+(?:(?:please|then|after that|afterwards|later|now|just)\s+|(?:пожалуйста|тогда|потом|затем|после этого|теперь|отдельно)\s+)*(?:show|покажи)\b.*$/iu,
      '',
    )
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.!?]+$/g, '')
    .trim();

  return normalized ? normalized : undefined;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

export function isForgetAllQualifier(selectorText: string): boolean {
  return /(?:^|\s)(?:all|every|все|всех|каждую|каждый|каждое)(?:\s|$)/iu.test(selectorText);
}

function containsMemoryCommandAnywhere(content: string): boolean {
  // Check if any sentence/clause contains a command verb (not just the first one)
  const sentences = content.split(/[.;!?]\s+/);
  return sentences.some((sentence) => startsWithDeterministicMemoryCommand(sentence.trim()));
}

function containsInspectClause(content: string): boolean {
  return (
    splitIntoClauses(content).some((clause) => isMemoryInspectCommand(clause)) ||
    /(?:show|покажи)[^.!?\n]{0,120}(?:memory(?:\s+snapshot)?|snapshot|память|снэпшот)[^.!?\n]{0,80}/iu.test(content)
  );
}

function toCommandKey(command: MemoryCommand): string {
  if (command.action === 'inspect') {
    return 'inspect';
  }

  if (isFactCommand(command)) {
    const expectedValue = command.action === 'forget_fact' ? command.expectedValue : undefined;
    return `${command.action}:${command.key}:${expectedValue ?? ''}`;
  }

  const selectorFingerprint = [...tokenize(command.selectorText)].sort().join('|');
  return `${command.action}:${command.kind}:${selectorFingerprint}`;
}

