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
    `^\\s*${COMMAND_LEAD_IN}(?:show(?: me)?(?: after that)?(?: your| the)?(?: updated| final| latest| current)?\\s+(?:memory(?:\\s+snapshot)?|snapshot)(?:\\s+(?:diff|difference|changes?))?)${COMMAND_END}`,
    'iu',
  ),
  new RegExp(
    `^\\s*${COMMAND_LEAD_IN}(?:покажи(?: мне)?(?: после этого)?(?:(?:\\s+(?:обновл[её]н(?:ную|ый)|финальн(?:ую|ый)|текущ(?:ую|ий)|последн(?:юю|ий)))?\\s+(?:память|snapshot|снэпшот)(?:\\s+памяти)?(?:\\s+(?:diff|разниц(?:у|а)|дельт(?:у|а)|изменени(?:я|й)))?))${COMMAND_END}`,
    'iu',
  ),
  // Free-form inspect: "what do you remember/know about me"
  /^\s*(?:what\s+do\s+you\s+(?:remember|know)\s+(?:about|of)\s+me)[.!?]*\s*$/iu,
  // Free-form inspect: "что ты (?:помнишь|знаешь) обо мне"
  /^\s*что\s+ты\s+(?:помнишь|знаешь)\s+(?:обо?\s+мне|про\s+меня)[.!?]*\s*$/iu,
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
