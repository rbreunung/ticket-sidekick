import { isSafePathSegment } from '../../tools/pathSafety';

/** Why an explicit ticket key cannot be used, or undefined when it can. */
export function ticketKeyProblem(key: string): string | undefined {
  if (!key) return 'A ticket key is required, e.g. PROJ-123.';
  if (!isSafePathSegment(key)) return `"${key}" is not a valid ticket key.`;
  return undefined;
}
