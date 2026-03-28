import type { EpisodicMemoryKind, UserProfileFactKey } from './memory-command.types';

export type CommandResponseLanguage = 'en' | 'ru';

const FACT_LABELS: Record<CommandResponseLanguage, Record<UserProfileFactKey, string>> = {
  en: {
    name: 'name',
    role: 'role',
    project: 'project',
    goal: 'goal',
    stack: 'tech stack',
  },
  ru: {
    name: 'имени',
    role: 'роли',
    project: 'проекте',
    goal: 'цели',
    stack: 'стеке',
  },
};

const EPISODIC_LABELS: Record<CommandResponseLanguage, Record<EpisodicMemoryKind, string>> = {
  en: {
    goal: 'goal',
    constraint: 'constraint',
    decision: 'decision',
    background: 'background context',
    working_context: 'working context',
    task: 'task',
  },
  ru: {
    goal: 'цели',
    constraint: 'ограничении',
    decision: 'решении',
    background: 'фоновом контексте',
    working_context: 'рабочем контексте',
    task: 'задаче',
  },
};

function getFactLabel(language: CommandResponseLanguage, key: UserProfileFactKey): string {
  return FACT_LABELS[language][key];
}

function getEpisodicLabel(language: CommandResponseLanguage, kind: EpisodicMemoryKind): string {
  return EPISODIC_LABELS[language][kind];
}

export function detectCommandResponseLanguage(content: string): CommandResponseLanguage {
  const cyrillicCount = (content.match(/[А-Яа-яЁё]/g) ?? []).length;
  const latinCount = (content.match(/[A-Za-z]/g) ?? []).length;

  if (/(?:забуд|закреп|откреп|покажи|памят|снэпшот)/iu.test(content)) {
    return 'ru';
  }

  if (cyrillicCount > latinCount) {
    return 'ru';
  }

  return 'en';
}

export function buildSnapshotOperationNote(
  language: CommandResponseLanguage,
  facts: string,
  episodicMemories: string,
  diff?: string,
): string {
  if (language === 'ru') {
    return `Снэпшот управляемой памяти: userFacts=[${facts}]. episodicMemories=[${episodicMemories}].${diff ? ` diff=[${diff}].` : ''}`;
  }

  return `Managed memory snapshot: userFacts=[${facts}]. episodicMemories=[${episodicMemories}].${diff ? ` diff=[${diff}].` : ''}`;
}

export function buildForgetFactByValueDeletedNote(
  language: CommandResponseLanguage,
  key: UserProfileFactKey,
  expectedValue: string,
): string {
  if (language === 'ru') {
    return `Я забыл сохранённый факт о ${getFactLabel(language, key)} со значением "${expectedValue}".`;
  }

  return `I forgot your stored ${key} fact with value "${expectedValue}".`;
}

export function buildForgetFactHistoryPrunedNote(
  language: CommandResponseLanguage,
  key: UserProfileFactKey,
  expectedValue: string,
): string {
  if (language === 'ru') {
    return `Я удалил старое значение факта о ${getFactLabel(language, key)}: "${expectedValue}".`;
  }

  return `I removed older ${key} value "${expectedValue}" from revision history.`;
}

export function buildForgetFactValueNotFoundNote(
  language: CommandResponseLanguage,
  key: UserProfileFactKey,
  expectedValue: string,
): string {
  if (language === 'ru') {
    return `Я не нашёл сохранённый факт о ${getFactLabel(language, key)} со значением ${expectedValue}, который можно забыть.`;
  }

  return `I couldn't find a stored ${key} fact matching ${expectedValue} to forget.`;
}

export function buildForgetFactNotFoundNote(language: CommandResponseLanguage, key: UserProfileFactKey): string {
  if (language === 'ru') {
    return `Не найден сохранённый факт о ${getFactLabel(language, key)}, который можно забыть.`;
  }

  return `No stored ${key} fact was found to forget.`;
}

export function buildForgetFactDeletedNote(
  language: CommandResponseLanguage,
  key: UserProfileFactKey,
  currentValue: string,
): string {
  if (language === 'ru') {
    return `Я забыл сохранённый факт о ${getFactLabel(language, key)} (было: "${currentValue}").`;
  }

  return `I forgot your stored ${key} fact (was "${currentValue}").`;
}

export function buildFactPinNotFoundNote(
  language: CommandResponseLanguage,
  key: UserProfileFactKey,
  pinned: boolean,
): string {
  if (language === 'ru') {
    return `Не найден сохранённый факт о ${getFactLabel(language, key)}, который можно ${pinned ? 'закрепить' : 'открепить'}.`;
  }

  return `No stored ${key} fact was found to ${pinned ? 'pin' : 'unpin'}.`;
}

export function buildFactPinnedNote(
  language: CommandResponseLanguage,
  key: UserProfileFactKey,
  value: string,
): string {
  if (language === 'ru') {
    return `Я закрепил сохранённый факт о ${getFactLabel(language, key)}: "${value}".`;
  }

  return `I pinned your stored ${key} fact: "${value}".`;
}

export function buildFactUnpinnedNote(
  language: CommandResponseLanguage,
  key: UserProfileFactKey,
  value: string,
): string {
  if (language === 'ru') {
    return `Я открепил сохранённый факт о ${getFactLabel(language, key)}: "${value}".`;
  }

  return `I unpinned your stored ${key} fact: "${value}".`;
}

export function buildForgetAllEpisodicDeletedNote(
  language: CommandResponseLanguage,
  kind: EpisodicMemoryKind,
  deletedCount: number,
): string {
  if (language === 'ru') {
    return `Я забыл все сохранённые записи об ${getEpisodicLabel(language, kind)} (${deletedCount} удалено).`;
  }

  return `I forgot all stored ${kind} memories (${deletedCount} removed).`;
}

export function buildForgetAllEpisodicNotFoundNote(
  language: CommandResponseLanguage,
  kind: EpisodicMemoryKind,
): string {
  if (language === 'ru') {
    return `Не найдено сохранённых записей об ${getEpisodicLabel(language, kind)}, которые можно удалить.`;
  }

  return `No stored ${kind} memories were found to delete.`;
}

export function buildEpisodicNotFoundNote(
  language: CommandResponseLanguage,
  kind: EpisodicMemoryKind,
  action: 'delete' | 'pin' | 'unpin',
): string {
  if (language === 'ru') {
    const verb = action === 'delete' ? 'удалить' : action === 'pin' ? 'закрепить' : 'открепить';
    return `Не найдена сохранённая запись об ${getEpisodicLabel(language, kind)}, которую можно ${verb}.`;
  }

  return `No stored ${kind} memory was found to ${action}.`;
}

export function buildForgetEpisodicDeletedNote(
  language: CommandResponseLanguage,
  kind: EpisodicMemoryKind,
  summary: string,
): string {
  if (language === 'ru') {
    return `Я забыл текущую запись об ${getEpisodicLabel(language, kind)}: "${summary}".`;
  }

  return `I forgot the current ${kind} memory: "${summary}".`;
}

export function buildEpisodicPinnedNote(
  language: CommandResponseLanguage,
  kind: EpisodicMemoryKind,
  summary: string,
): string {
  if (language === 'ru') {
    return `Я закрепил текущую запись об ${getEpisodicLabel(language, kind)}: ${summary}.`;
  }

  return `I pinned the current ${kind} memory: ${summary}.`;
}

export function buildEpisodicUnpinnedNote(
  language: CommandResponseLanguage,
  kind: EpisodicMemoryKind,
  summary: string,
): string {
  if (language === 'ru') {
    return `Я открепил текущую запись об ${getEpisodicLabel(language, kind)}: ${summary}.`;
  }

  return `I unpinned the current ${kind} memory: ${summary}.`;
}
