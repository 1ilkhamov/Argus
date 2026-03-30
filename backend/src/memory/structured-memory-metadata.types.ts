export type StructuredMemoryTurnReference = {
  conversationId: string;
  messageId: string;
  createdAt: string;
};

export type StructuredMemoryProvenance = {
  firstObservedAt: string;
  lastObservedAt: string;
  firstObservedIn?: StructuredMemoryTurnReference;
  lastObservedIn?: StructuredMemoryTurnReference;
};
