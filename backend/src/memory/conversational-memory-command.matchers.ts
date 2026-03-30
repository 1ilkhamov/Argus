const COMMAND_LEAD_IN =
  '(?:(?:please|then|after that|afterwards|later|now|just)\\s+|(?:пожалуйста|тогда|потом|затем|после этого|теперь|отдельно)\\s+)*';
const COMMAND_END = '(?=$|\\s|[.!?,;:])';
const COMMAND_VERBS = '(?:show|forget|delete|remove|pin|unpin|покажи|забудь|удали|закрепи|открепи)';

export const MEMORY_COMMAND_SPLIT = new RegExp(
  '(?:[.;]\\s*|,\\s*(?=' +
    COMMAND_LEAD_IN +
    COMMAND_VERBS +
    COMMAND_END +
    ')|\\s+(?:and|и)\\s+(?=' +
    COMMAND_LEAD_IN +
    COMMAND_VERBS +
    COMMAND_END +
    '))',
  'iu',
);

const INSPECT_COMMAND_PATTERNS = [
  new RegExp(
    `^\\s*${COMMAND_LEAD_IN}(?:show (?:me )?(?:your |the )?(?:updated )?(?:memory(?: snapshot)?|snapshot))${COMMAND_END}`,
    'iu',
  ),
  new RegExp(
    `^\\s*${COMMAND_LEAD_IN}(?:покажи(?: мне)?(?: после этого)?(?: обновл[её]н(?:ную|ый))? память|покажи(?: мне)?(?: после этого)?\\s+(?:snapshot|снэпшот)\\s+памяти)${COMMAND_END}`,
    'iu',
  ),
];

export function isMemoryInspectCommand(content: string): boolean {
  return INSPECT_COMMAND_PATTERNS.some((pattern) => pattern.test(content.trim()));
}

export function startsWithMemoryForgetVerb(content: string): boolean {
  return new RegExp(`^${COMMAND_LEAD_IN}(?:forget|delete|remove|забудь|удали)${COMMAND_END}`, 'iu').test(
    content.trim(),
  );
}

export function startsWithMemoryPinVerb(content: string): boolean {
  return new RegExp(`^${COMMAND_LEAD_IN}(?:pin|закрепи)${COMMAND_END}`, 'iu').test(content.trim());
}

export function startsWithMemoryUnpinVerb(content: string): boolean {
  return new RegExp(`^${COMMAND_LEAD_IN}(?:unpin|открепи)${COMMAND_END}`, 'iu').test(content.trim());
}

export function startsWithDeterministicMemoryCommand(content: string): boolean {
  return (
    isMemoryInspectCommand(content) ||
    startsWithMemoryForgetVerb(content) ||
    startsWithMemoryPinVerb(content) ||
    startsWithMemoryUnpinVerb(content)
  );
}

export function isDeterministicMemoryCommandMessage(content: string): boolean {
  return startsWithDeterministicMemoryCommand(content);
}
