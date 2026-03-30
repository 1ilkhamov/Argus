import type { Message } from '../chat/entities/message.entity';
import type { StructuredMemoryProvenance, StructuredMemoryTurnReference } from './structured-memory-metadata.types';

export function buildStructuredMemoryTurnReference(message: Message): StructuredMemoryTurnReference {
  return {
    conversationId: message.conversationId,
    messageId: message.id,
    createdAt: message.createdAt.toISOString(),
  };
}

export function buildStructuredMemoryProvenance(message: Message): StructuredMemoryProvenance {
  const reference = buildStructuredMemoryTurnReference(message);
  return {
    firstObservedAt: reference.createdAt,
    lastObservedAt: reference.createdAt,
    firstObservedIn: reference,
    lastObservedIn: reference,
  };
}

export function ensureStructuredMemoryProvenance(
  provenance: StructuredMemoryProvenance | undefined,
  updatedAt: string | undefined,
): StructuredMemoryProvenance | undefined {
  if (provenance) {
    return provenance;
  }

  if (!updatedAt) {
    return undefined;
  }

  return {
    firstObservedAt: updatedAt,
    lastObservedAt: updatedAt,
  };
}

export function mergeStructuredMemoryProvenance(
  existing: StructuredMemoryProvenance | undefined,
  incoming: StructuredMemoryProvenance | undefined,
  existingUpdatedAt?: string,
  incomingUpdatedAt?: string,
): StructuredMemoryProvenance | undefined {
  const normalizedExisting = ensureStructuredMemoryProvenance(existing, existingUpdatedAt);
  const normalizedIncoming = ensureStructuredMemoryProvenance(incoming, incomingUpdatedAt);

  if (!normalizedExisting) {
    return normalizedIncoming;
  }

  if (!normalizedIncoming) {
    return normalizedExisting;
  }

  const incomingHasEarlierFirstObservedAt =
    normalizedIncoming.firstObservedAt.localeCompare(normalizedExisting.firstObservedAt) < 0;
  const incomingHasLaterLastObservedAt =
    normalizedIncoming.lastObservedAt.localeCompare(normalizedExisting.lastObservedAt) > 0;

  return {
    firstObservedAt: incomingHasEarlierFirstObservedAt
      ? normalizedIncoming.firstObservedAt
      : normalizedExisting.firstObservedAt,
    lastObservedAt: incomingHasLaterLastObservedAt
      ? normalizedIncoming.lastObservedAt
      : normalizedExisting.lastObservedAt,
    firstObservedIn: pickTurnReference(
      incomingHasEarlierFirstObservedAt ? normalizedIncoming.firstObservedIn : normalizedExisting.firstObservedIn,
      incomingHasEarlierFirstObservedAt ? normalizedExisting.firstObservedIn : normalizedIncoming.firstObservedIn,
    ),
    lastObservedIn: pickTurnReference(
      incomingHasLaterLastObservedAt ? normalizedIncoming.lastObservedIn : normalizedExisting.lastObservedIn,
      incomingHasLaterLastObservedAt ? normalizedExisting.lastObservedIn : normalizedIncoming.lastObservedIn,
    ),
  };
}

function pickTurnReference(
  preferred: StructuredMemoryTurnReference | undefined,
  fallback: StructuredMemoryTurnReference | undefined,
): StructuredMemoryTurnReference | undefined {
  return preferred ?? fallback;
}
