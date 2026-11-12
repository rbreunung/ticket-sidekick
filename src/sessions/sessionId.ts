import { createHash } from 'crypto';

// One session per source: the id is derived from the board kind and the normalised source, so
// asking for the same report file, query, PR or project again finds the same session. The id is
// also a file name and part of a page address, hence hex only.

const ID_PATTERN = /^[0-9a-f]{24}$/;

export function sessionIdFor(kind: string, sourceKey: string): string {
  return createHash('sha256').update(`${kind}\n${sourceKey}`).digest('hex').slice(0, 24);
}

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/** The canvas instance id for a session, so the agent's second request reuses the open canvas. */
export function instanceIdForSession(kind: string, id: string): string {
  return `${kind}-${id}`;
}

/** The session id inside a canvas instance id, or undefined when it carries none. */
export function sessionIdFromInstance(kind: string, instanceId: string): string | undefined {
  const prefix = `${kind}-`;
  if (!instanceId.startsWith(prefix)) return undefined;
  const id = instanceId.slice(prefix.length);
  return isSessionId(id) ? id : undefined;
}
