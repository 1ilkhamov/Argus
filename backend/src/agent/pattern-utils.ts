/**
 * Shared pattern-matching utility used by detector modules.
 */

export function matchesAny(content: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(content));
}
