import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Regression guard for the "create from mail" bug (docs/issues/create_from_email-2026-09-11.md):
// a top-level `if (intent.operation === '<op>') { await handler(...); return; }` dispatch branch
// silently discards a ChatResult carrying session-continuity metadata, because the handler's
// return value is never propagated. The fix is `return await handler(...);` (or capturing the
// result in a variable that is itself returned).
//
// JiraParticipant.ts / BitbucketParticipant.ts import `vscode` and cannot be loaded by Vitest, so
// this can't be a behavioral test of the dispatch chain. Instead it statically verifies the
// convention: every handler whose declared return type is `Promise<vscode.ChatResult | void>` must
// have its return value propagated at every call site in the two participant dispatch files.

const participantDir = path.resolve(__dirname, '../participant');
const jiraHandlerDir = path.join(participantDir, 'jira');
const dispatchFiles = ['JiraParticipant.ts', 'BitbucketParticipant.ts'].map((f) => path.join(participantDir, f));

/** Collects every exported function name whose declared return type includes `ChatResult`. */
function collectChatResultHandlerNames(): string[] {
  const files = [
    ...fs.readdirSync(jiraHandlerDir).filter((f) => f.endsWith('.ts')).map((f) => path.join(jiraHandlerDir, f)),
    ...dispatchFiles,
  ];
  const names = new Set<string>();
  // `[^{]*?` (not `[\s\S]*?`) stops the lazy match at the first `{` (a function body opening) so
  // a function whose signature doesn't itself end in `Promise<ChatResult | void>` can't run on and
  // wrongly attribute a *later* function's matching signature to itself.
  const fnPattern = /export\s+async\s+function\s+(\w+)\s*\([^{]*?\):\s*Promise<vscode\.ChatResult\s*\|\s*void>/g;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const match of src.matchAll(fnPattern)) {
      names.add(match[1]);
    }
  }
  return [...names];
}

/**
 * For one dispatch file, finds every `await <name>(` call site and classifies whether the return
 * value is propagated: either the statement starts with `return await` / `return <name>(`, or the
 * call result is captured into a variable (`x = await name(...)`) — capture is trusted, since it
 * implies deliberate handling elsewhere, unlike a bare `await name(...); return;` drop.
 */
function findUnpropagatedCalls(filePath: string, handlerNames: string[]): string[] {
  const src = fs.readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  const violations: string[] = [];

  for (const name of handlerNames) {
    const callStart = new RegExp(`(^|[^.\\w])await\\s+${name}\\s*\\(`);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!callStart.test(line)) continue;

      const trimmed = line.trim();
      const isReturned = /^return\s+await\s+\w+\s*\(/.test(trimmed);
      const isCaptured = /=\s*await\s+\w+\s*\(/.test(trimmed) || /^(const|let|var)\s+/.test(trimmed);
      if (isReturned || isCaptured) continue;

      // Bare `await name(...)` — find the line where the statement's call closes (ends with ");")
      // and check whether a bare `return;` immediately follows (skipping blank lines and, if the
      // call sits inside a `try { ... }`, one immediately-following `catch { ... }` block too —
      // the shape `try { await name(...); } catch (err) { ... } return;` still drops the value on
      // the success path even though the surrounding `return;` is legitimate for the error path).
      let j = i;
      while (j < lines.length && !lines[j].trim().endsWith(');')) j++;
      let k = j + 1;
      while (k < lines.length && lines[k].trim() === '') k++;
      if (k < lines.length && /^\}\s*catch\b/.test(lines[k].trim())) {
        // The catch header itself (`} catch (err) {`) nets to zero open/close braces — its
        // leading `}` closes the try, its trailing `{` opens the catch body — so seed depth at 1
        // for that opened catch body rather than computing the header line's net.
        let depth = 1;
        let c = k + 1;
        while (c < lines.length && depth > 0) {
          depth += (lines[c].match(/\{/g) ?? []).length - (lines[c].match(/\}/g) ?? []).length;
          c++;
        }
        k = c;
        while (k < lines.length && lines[k].trim() === '') k++;
      }
      if (k < lines.length && lines[k].trim() === 'return;') {
        violations.push(`${path.basename(filePath)}:${i + 1} — \`await ${name}(...)\` followed by bare \`return;\` at line ${k + 1}; use \`return await ${name}(...)\` so its ChatResult (session-continuity metadata) propagates`);
      }
    }
  }
  return violations;
}

describe('dispatch chain propagates ChatResult from session-carrying handlers', () => {
  it('has no `await handler(...); return;` call sites for handlers that can return a ChatResult', () => {
    const handlerNames = collectChatResultHandlerNames();
    expect(handlerNames.length).toBeGreaterThan(0); // sanity: the discovery pattern still matches something

    const violations = dispatchFiles.flatMap((f) => findUnpropagatedCalls(f, handlerNames));
    expect(violations).toEqual([]);
  });
});
