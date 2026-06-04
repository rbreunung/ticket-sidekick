/**
 * Extract the first complete JSON object from a raw LLM response.
 *
 * Strips a surrounding ```json … ``` fence when present, then bracket-counts from the
 * first `{` to its matching `}` — correctly ignoring braces inside string literals and
 * any trailing prose the model appends after the object. Returns the object substring, or
 * `null` when no object is found.
 *
 * Shared by both the Jira intent parser (`parseIntent`) and the Bitbucket review parser so
 * the two participants extract model JSON identically without depending on each other.
 */
export function extractJsonObject(raw: string): string | null {
  // Strip markdown code fence when model wraps output in ```json ... ```
  const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  const text = fenced ? fenced[1] : raw;

  // Bracket-count from the first { to its matching } — handles trailing text
  // that contains extra braces (which the greedy /\{[\s\S]*\}/ gets wrong).
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inString && ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
