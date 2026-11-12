// The length rule that tells a per-start key from an ordinary path segment or log word. Every
// generated key (the MCP bearer key, the canvas key) is 43 base64url characters; anything of 32 or
// more such characters is treated as a key, so a key is refused, masked or redacted the same way
// wherever it shows up.

export const KEY_LENGTH_FLOOR = 32;

const KEY_RUN = new RegExp(`[A-Za-z0-9_-]{${KEY_LENGTH_FLOOR},}`, 'g');

/** Masks every run of key characters at least as long as a key as `[key]`. */
export function maskKeys(text: string): string {
  return text.replace(KEY_RUN, '[key]');
}
