# Spell Check Refactor + JiraParticipant Refactor + Outlook Email → Jira Ticket

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the oversize JiraParticipant, convert spell check to an on-demand command, and add `@jira create from email` to turn Outlook emails into Jira tickets via Microsoft Graph API.

**Architecture:** Three sequential phases — Phase 0 removes the automatic spell-check interrupt and adds `@jira spell check <KEY>` as an explicit command; Phase 1 splits the 2042-line `JiraParticipant.ts` into focused handler modules under `src/participant/jira/` with no behaviour change; Phase 2 adds the Outlook email integration following the same three-layer client/service/handler pattern already used for Jira and Bitbucket.

**Tech Stack:** TypeScript, VS Code Extension API (`vscode.authentication` for Microsoft OAuth), Microsoft Graph API (mail endpoints), Vitest (unit tests), esbuild (bundler).

**Spec:** `docs/superpowers/specs/2026-05-21-outlook-email-to-jira-ticket-design.md`

---

## Phase 0 — Spell Check as an Explicit Command

### Task 1: Remove automatic spell check from the field-update flow

**Files:**
- Modify: `src/participant/sessionState.ts`
- Modify: `src/participant/JiraParticipant.ts`
- Modify: `package.json`

- [ ] **Step 1: Delete `SpellCheckSession` from `sessionState.ts`**

Find and remove these lines (around line 248):
```typescript
export interface SpellCheckSession {
  original: string;
  corrected: string;
  pending: FieldUpdatePreviewSession;
}
```
Also remove `SpellCheckSession` from the import list on line 14 of `JiraParticipant.ts`.

- [ ] **Step 2: Remove `spellCheckEnabled` parameter from `continueSetField`**

Change the function signature (around line 1064):
```typescript
// BEFORE
async function continueSetField(
  ticketKeys: string[],
  field: JiraFieldMeta,
  fieldValueRaw: string,
  arrayOp: 'set' | 'add' | 'remove',
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  spellCheckEnabled: boolean,
): Promise<void> {

// AFTER
async function continueSetField(
  ticketKeys: string[],
  field: JiraFieldMeta,
  fieldValueRaw: string,
  arrayOp: 'set' | 'add' | 'remove',
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<void> {
```

Then delete the spell-check block inside the function body (the `if (spellCheckEnabled && ...)` block that creates `SpellCheckSession` and returns early).

- [ ] **Step 3: Remove `spellCheckEnabled` parameter from `handleSetField`**

Same removal (around line 1161) — drop the parameter and the `spellCheckEnabled` argument in the `continueSetField(...)` call inside.

- [ ] **Step 4: Remove the spell-check session dispatch block in `createJiraParticipant`**

Delete the block starting with (around line 1541):
```typescript
if (lastResponse.includes('<!-- jira:spell-check -->')) {
  // ...
}
```

- [ ] **Step 5: Remove the two `spellCheckEnabled` call sites in `createJiraParticipant`**

Search for `config.spellCheck` and delete both argument occurrences in calls to `handleSetField`.

- [ ] **Step 6: Remove the `spellCheck` VS Code setting from `package.json`**

Delete these lines (around line 119):
```json
"ticketSidekick.jira.spellCheck": {
  "type": "boolean",
  "default": true,
  "description": "When enabled, @jira set on a text field offers a spelling/grammar-corrected version before applying the update. Disable per workspace to skip the correction step."
},
```

- [ ] **Step 7: Verify no remaining references**

```bash
grep -rn "spellCheck\|SpellCheckSession\|jira:spell-check\|jira\.session\.spellCheck" src/
```
Expected: zero matches.

- [ ] **Step 8: Run tests**

```bash
npm run compile && npm test
```
Expected: TypeScript clean, all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/participant/sessionState.ts src/participant/JiraParticipant.ts package.json
git commit -m "refactor: remove automatic spell check from field-update flow"
```

---

### Task 2: Add `@jira spell check` as an explicit command

**Files:**
- Modify: `src/participant/JiraParticipant.ts`

- [ ] **Step 1: Add `'spellCheck'` to the `Operation` union (around line 19)**

```typescript
type Operation =
  | 'getTicket'
  | 'summarizeTicket'
  | 'showComments'
  | 'getComments'
  | 'addComment'
  | 'updateField'
  | 'showFields'
  | 'searchJql'
  | 'validateFields'
  | 'createTicket'
  | 'discoverWorkflow'
  | 'runCleanup'
  | 'bulkTransition'
  | 'bulkUpdateField'
  | 'loadTicket'
  | 'spellCheck';
```

- [ ] **Step 2: Add `spellCheck` entry to `INTENT_PROMPT` (at the end of the operation list)**

Append inside the existing prompt string before the closing backtick:
```
- spellCheck: check and correct spelling and grammar on a ticket's description; triggered by "spell check", "fix grammar", "check spelling", "proofread"
```

- [ ] **Step 3: Add `wikiToMarkdown` to the `markdownFormatter` import (line 6)**

```typescript
import { formatJiraBody, wikiToMarkdown } from '../utils/markdownFormatter';
```

- [ ] **Step 4: Add `extractTextFromAdf` to the `TicketService` import (line 5)**

```typescript
import { TicketService, assembleDescription, resolveFieldIdFuzzy, formatIssueFields, extractTextFromAdf } from '../services/TicketService';
```

- [ ] **Step 5: Add `handleSpellCheck` function (place it near `handleSetField`, before `createJiraParticipant`)**

```typescript
async function handleSpellCheck(
  ticketKey: string,
  ticketService: TicketService,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  ws: vscode.Memento,
): Promise<void> {
  const issue = await ticketService.getIssue(ticketKey);
  const rawDescription = extractTextFromAdf(issue.fields.description);
  if (!rawDescription.trim()) {
    stream.markdown(`**${ticketKey}** has no description to check.`);
    return;
  }
  const markdownDescription = wikiToMarkdown(rawDescription);
  const corrected = await spellCheckValue(markdownDescription, model, token);
  if (!corrected) {
    stream.markdown(`No spelling or grammar issues found in **${ticketKey}**.`);
    return;
  }
  const session: ContentSession = {
    ticketKey,
    operation: 'updateDescription',
    currentContent: corrected,
    historyContext: undefined,
  };
  await streamContentPreview(session, stream, ws);
  stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->`);
}
```

- [ ] **Step 6: Add `spellCheck` case to the intent dispatch switch (inside `createJiraParticipant`, in the `switch (intent.operation)` block)**

```typescript
case 'spellCheck': {
  if (!ticketKey) {
    stream.markdown('No ticket key found. Please specify a ticket, e.g. `@jira spell check PROJ-123`.');
    break;
  }
  await handleSpellCheck(ticketKey, ticketService, request.model, stream, token, ws);
  break;
}
```

- [ ] **Step 7: Run tests**

```bash
npm run compile && npm test
```
Expected: TypeScript clean, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/participant/JiraParticipant.ts
git commit -m "feat: add @jira spell check command as explicit on-demand operation"
```

---

## Phase 1 — Refactor `JiraParticipant.ts`

Each task extracts a cohesive group of functions into a new file under `src/participant/jira/`. Functions are moved verbatim — only imports change. After every task: `npm run compile && npm test` must pass.

### Task 3: Extract `llmHelpers.ts` (LLM utilities + intent types)

**Files:**
- Create: `src/participant/jira/llmHelpers.ts`
- Modify: `src/participant/JiraParticipant.ts`

- [ ] **Step 1: Create `src/participant/jira/llmHelpers.ts` with these exact imports and exports**

Move `Operation`, `ParsedIntent`, `INTENT_PROMPT`, and the seven LLM functions from `JiraParticipant.ts` into this file:

```typescript
import * as vscode from 'vscode';
import type { JiraComment } from '../../jira/IJiraClient';
import { serializeTurns } from '../sessionState';

// Move here verbatim: Operation type, ParsedIntent interface, INTENT_PROMPT constant
// Move here verbatim: parseIntent, generateContent, isLmRefusal,
//   extractHistoryTurns, buildHistoryContext, synthesizeComments,
//   generateDescriptionAndCommentsSummary
//
// All moved items must be exported (add `export` keyword to each).
```

- [ ] **Step 2: Update `JiraParticipant.ts` imports**

Replace the now-deleted local definitions with an import at the top:
```typescript
import type { Operation, ParsedIntent } from './jira/llmHelpers';
import { parseIntent, generateContent, isLmRefusal, extractHistoryTurns, buildHistoryContext, synthesizeComments, generateDescriptionAndCommentsSummary, INTENT_PROMPT } from './jira/llmHelpers';
```

- [ ] **Step 3: Run tests**

```bash
npm run compile && npm test
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/participant/jira/llmHelpers.ts src/participant/JiraParticipant.ts
git commit -m "refactor: extract llmHelpers.ts from JiraParticipant"
```

---

### Task 4: Extract `ticketContext.ts` (ticket/project key resolution)

**Files:**
- Create: `src/participant/jira/ticketContext.ts`
- Modify: `src/participant/JiraParticipant.ts`

- [ ] **Step 1: Create `src/participant/jira/ticketContext.ts`**

```typescript
import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { extractTicketId } from '../../utils/branchParser';
import { extractLastTicketFromText } from '../sessionState';

// Move here verbatim (with export): getLastAssistantText, resolveTicketFromBranch,
//   resolveProjectKey, parseLastTicketFromContext
```

- [ ] **Step 2: Update `JiraParticipant.ts`**

```typescript
import { getLastAssistantText, resolveTicketFromBranch, resolveProjectKey, parseLastTicketFromContext } from './jira/ticketContext';
```
Remove the `execSync` import if it's no longer used elsewhere in `JiraParticipant.ts` (check with `grep execSync`).

- [ ] **Step 3: Run and commit**

```bash
npm run compile && npm test
git add src/participant/jira/ticketContext.ts src/participant/JiraParticipant.ts
git commit -m "refactor: extract ticketContext.ts from JiraParticipant"
```

---

### Task 5: Extract `contentHandler.ts` (content preview/refinement)

**Files:**
- Create: `src/participant/jira/contentHandler.ts`
- Modify: `src/participant/JiraParticipant.ts`

- [ ] **Step 1: Create `src/participant/jira/contentHandler.ts`**

```typescript
import * as vscode from 'vscode';
import type { TicketService } from '../../services/TicketService';
import { markdownToJiraWiki } from '../../utils/markdownToJiraWiki';
import type { ContentSession } from '../sessionState';
import { isCancellation, isConfirmation } from '../sessionState';
import { generateContent, isLmRefusal } from './llmHelpers';

// Move here verbatim (with export): gatherFileContent, buildContentContext,
//   streamContentPreview, handleContentSession
```

- [ ] **Step 2: Update `JiraParticipant.ts`**

```typescript
import { gatherFileContent, buildContentContext, streamContentPreview, handleContentSession } from './jira/contentHandler';
```

- [ ] **Step 3: Run and commit**

```bash
npm run compile && npm test
git add src/participant/jira/contentHandler.ts src/participant/JiraParticipant.ts
git commit -m "refactor: extract contentHandler.ts from JiraParticipant"
```

---

### Task 6: Extract `createHandler.ts` (ticket creation flow)

**Files:**
- Create: `src/participant/jira/createHandler.ts`
- Modify: `src/participant/JiraParticipant.ts`

- [ ] **Step 1: Create `src/participant/jira/createHandler.ts`**

```typescript
import * as vscode from 'vscode';
import type { IJiraClient } from '../../jira/IJiraClient';
import { TicketService, assembleDescription } from '../../services/TicketService';
import { TemplateService } from '../../templates/TemplateService';
import type { JiraTemplate } from '../../templates/TemplateService';
import { FieldResolver } from '../../templates/FieldResolver';
import type { CreationSession, IssueTypeSelectionSession, TemplateSelectionSession } from '../sessionState';
import {
  isCancellation, isConfirmation, parseTemplateSelection,
  parseIssueTypeSelection, extractCreatedKeyFromConfirmation,
} from '../sessionState';
import { generateContent, isLmRefusal } from './llmHelpers';
import { streamContentPreview } from './contentHandler';
import { resolveProjectKey } from './ticketContext';

// Move here verbatim (with export): checkSectionCoverage, streamIssueTypeSelection,
//   continueAfterIssueType, streamNextSection, streamTemplateSelection,
//   finishTicketCreation, handleCreateTicket
//
// Note: checkSectionCoverage is an LLM call only used inside this file.
// Keep it here — do NOT move it to llmHelpers.ts.
```

- [ ] **Step 2: Update `JiraParticipant.ts`**

```typescript
import { streamIssueTypeSelection, continueAfterIssueType, streamNextSection, streamTemplateSelection, finishTicketCreation, handleCreateTicket } from './jira/createHandler';
```

- [ ] **Step 3: Run and commit**

```bash
npm run compile && npm test
git add src/participant/jira/createHandler.ts src/participant/JiraParticipant.ts
git commit -m "refactor: extract createHandler.ts from JiraParticipant"
```

---

### Task 7: Extract `loadHandler.ts` (load-ticket handler)

**Files:**
- Create: `src/participant/jira/loadHandler.ts`
- Modify: `src/participant/JiraParticipant.ts`

- [ ] **Step 1: Create `src/participant/jira/loadHandler.ts`**

```typescript
import * as vscode from 'vscode';
import type { JiraComment } from '../../jira/IJiraClient';
import type { TicketService } from '../../services/TicketService';
import type { LoadSkippedSession, MoreCommentsSession, CommentListSession } from '../sessionState';
import {
  isCancellation, isConfirmation, buildCommentListSession,
  parseCommentIndex, formatCommentsInFull, parseSkippedAttachmentSelection,
  rewriteAttachmentLinks,
} from '../sessionState';
import { synthesizeComments, generateDescriptionAndCommentsSummary } from './llmHelpers';

// Move here verbatim (with export): serializeCommentsForLLM, handleLoadTicket
```

- [ ] **Step 2: Update `JiraParticipant.ts`**

```typescript
import { serializeCommentsForLLM, handleLoadTicket } from './jira/loadHandler';
```

- [ ] **Step 3: Run and commit**

```bash
npm run compile && npm test
git add src/participant/jira/loadHandler.ts src/participant/JiraParticipant.ts
git commit -m "refactor: extract loadHandler.ts from JiraParticipant"
```

---

### Task 8: Extract `fieldHandler.ts` (field update + spell check command)

**Files:**
- Create: `src/participant/jira/fieldHandler.ts`
- Modify: `src/participant/JiraParticipant.ts`

- [ ] **Step 1: Create `src/participant/jira/fieldHandler.ts`**

```typescript
import * as vscode from 'vscode';
import { TicketService, resolveFieldIdFuzzy, extractTextFromAdf } from '../../services/TicketService';
import type { JiraFieldMeta } from '../../jira/IJiraClient';
import type { FieldUpdatePreviewSession, FieldSelectionSession, SprintSelectionSession, ContentSession } from '../sessionState';
import { isCancellation } from '../sessionState';
import { spellCheckValue } from './llmHelpers';
import { streamContentPreview } from './contentHandler';
import { wikiToMarkdown } from '../../utils/markdownFormatter';

// Move here verbatim (with export): spellCheckValue, streamFieldUpdatePreview,
//   continueSetField, handleSetField, handleSpellCheck
```

Note: `spellCheckValue` was in `JiraParticipant.ts` and is already used by `handleSpellCheck` added in Task 2. Move both together.

- [ ] **Step 2: Update `JiraParticipant.ts`**

```typescript
import { streamFieldUpdatePreview, continueSetField, handleSetField, handleSpellCheck } from './jira/fieldHandler';
```
Remove the now-redundant local `import { wikiToMarkdown }` and `extractTextFromAdf` if they are no longer used directly in `JiraParticipant.ts`.

- [ ] **Step 3: Run and commit**

```bash
npm run compile && npm test
git add src/participant/jira/fieldHandler.ts src/participant/JiraParticipant.ts
git commit -m "refactor: extract fieldHandler.ts from JiraParticipant"
```

---

### Task 9: Extract `cleanupHandler.ts` and `workflowHandler.ts`

**Files:**
- Create: `src/participant/jira/cleanupHandler.ts`
- Create: `src/participant/jira/workflowHandler.ts`
- Modify: `src/participant/JiraParticipant.ts`

- [ ] **Step 1: Create `src/participant/jira/cleanupHandler.ts`**

```typescript
import * as vscode from 'vscode';
import type { IJiraClient } from '../../jira/IJiraClient';
import type { TicketService } from '../../services/TicketService';
import type { CleanupRule } from '../../templates/TemplateService';
import type { TransitionBatchSession, TransitionBatchTicket, TransitionSubtask, ResolutionSelectionSession } from '../sessionState';
import { isCancellation, isConfirmation, parseResolutionSelection, parseSkipInput } from '../sessionState';

// Move here verbatim (with export): streamReviewScreen, executeCleanupBatch, handleRunCleanup
```

- [ ] **Step 2: Create `src/participant/jira/workflowHandler.ts`**

```typescript
import * as vscode from 'vscode';
import type { IJiraClient } from '../../jira/IJiraClient';
import { discoverWorkflow, loadWorkflowCache, saveWorkflowCache, findPath } from '../../services/WorkflowService';
import type { WorkflowGraph } from '../../services/WorkflowService';
import type { ParsedIntent } from './llmHelpers';

// Move here verbatim (with export): handleDiscoverWorkflow
```

- [ ] **Step 3: Update `JiraParticipant.ts`**

```typescript
import { streamReviewScreen, executeCleanupBatch, handleRunCleanup } from './jira/cleanupHandler';
import { handleDiscoverWorkflow } from './jira/workflowHandler';
```
Remove `discoverWorkflow`, `loadWorkflowCache`, `saveWorkflowCache`, `findPath`, `WorkflowGraph` imports from `JiraParticipant.ts` if no longer used there.

- [ ] **Step 4: Run and commit**

```bash
npm run compile && npm test
git add src/participant/jira/cleanupHandler.ts src/participant/jira/workflowHandler.ts src/participant/JiraParticipant.ts
git commit -m "refactor: extract cleanupHandler.ts and workflowHandler.ts from JiraParticipant"
```

---

### Task 10: Verify `JiraParticipant.ts` is now slim dispatch only

**Files:**
- Modify: `src/participant/JiraParticipant.ts` (cleanup only)

- [ ] **Step 1: Check the line count**

```bash
wc -l src/participant/JiraParticipant.ts
```
Expected: 250–350 lines. If it is still substantially larger, scan for any remaining function bodies that belong in a handler file and move them.

- [ ] **Step 2: Confirm only imports + `createJiraParticipant` remain**

```bash
grep -n "^async function\|^function\|^export function" src/participant/JiraParticipant.ts
```
Expected: only `export function createJiraParticipant`.

- [ ] **Step 3: Run full test suite one final time**

```bash
npm run compile && npm test
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/participant/JiraParticipant.ts
git commit -m "refactor: JiraParticipant.ts reduced to dispatch only (~250 lines)"
```

---

## Phase 2 — Outlook Email → Jira Ticket

### Task 11: `htmlToMarkdown` utility — tests first

**Files:**
- Create: `src/utils/htmlToMarkdown.ts`
- Create: `src/test/htmlToMarkdown.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/test/htmlToMarkdown.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { htmlToMarkdown } from '../utils/htmlToMarkdown';

describe('htmlToMarkdown', () => {
  it('converts headings h1-h3', () => {
    expect(htmlToMarkdown('<h1>Title</h1>')).toBe('# Title');
    expect(htmlToMarkdown('<h2>Sub</h2>')).toBe('## Sub');
    expect(htmlToMarkdown('<h3>Sub</h3>')).toBe('### Sub');
  });

  it('converts bold and italic', () => {
    expect(htmlToMarkdown('<b>bold</b>')).toBe('**bold**');
    expect(htmlToMarkdown('<strong>bold</strong>')).toBe('**bold**');
    expect(htmlToMarkdown('<i>italic</i>')).toBe('_italic_');
    expect(htmlToMarkdown('<em>italic</em>')).toBe('_italic_');
  });

  it('converts unordered lists', () => {
    const html = '<ul><li>one</li><li>two</li></ul>';
    expect(htmlToMarkdown(html)).toBe('- one\n- two');
  });

  it('converts ordered lists', () => {
    const html = '<ol><li>first</li><li>second</li></ol>';
    expect(htmlToMarkdown(html)).toBe('1. first\n2. second');
  });

  it('converts a simple GFM table', () => {
    const html = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
    const result = htmlToMarkdown(html);
    expect(result).toContain('| A | B |');
    expect(result).toContain('| --- | --- |');
    expect(result).toContain('| 1 | 2 |');
  });

  it('converts fenced code blocks', () => {
    const html = '<pre><code>const x = 1;</code></pre>';
    expect(htmlToMarkdown(html)).toContain('```\nconst x = 1;\n```');
  });

  it('converts inline code', () => {
    expect(htmlToMarkdown('<code>foo()</code>')).toBe('`foo()`');
  });

  it('converts links', () => {
    expect(htmlToMarkdown('<a href="https://example.com">click</a>')).toBe('[click](https://example.com)');
  });

  it('replaces cid: inline images using the map', () => {
    const map = new Map([['abc123@host', 'screenshot.png']]);
    const html = '<img src="cid:abc123@host" />';
    expect(htmlToMarkdown(html, map)).toBe('[📎 screenshot.png]');
  });

  it('uses contentId as fallback when not in map', () => {
    const html = '<img src="cid:unknown@host" />';
    expect(htmlToMarkdown(html)).toBe('[📎 unknown@host]');
  });

  it('strips script and style blocks', () => {
    const html = '<style>.x{color:red}</style><p>Text</p><script>alert(1)</script>';
    expect(htmlToMarkdown(html)).toBe('Text');
  });

  it('decodes common HTML entities', () => {
    expect(htmlToMarkdown('&amp; &lt; &gt; &nbsp; &quot;')).toBe('& < >   "');
  });

  it('converts paragraphs to double newlines', () => {
    const result = htmlToMarkdown('<p>First</p><p>Second</p>');
    expect(result).toBe('First\n\nSecond');
  });
});
```

- [ ] **Step 2: Run tests — confirm they all fail**

```bash
npm test -- htmlToMarkdown
```
Expected: all tests fail with "Cannot find module '../utils/htmlToMarkdown'".

- [ ] **Step 3: Implement `src/utils/htmlToMarkdown.ts`**

```typescript
export function htmlToMarkdown(html: string, inlineImageMap: Map<string, string> = new Map()): string {
  let s = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');

  s = s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Tables (process before headings to avoid header-row confusion)
  s = s.replace(/<table[\s\S]*?<\/table>/gi, (table) => {
    const rows: string[][] = [];
    table.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_: string, row: string) => {
      const cells: string[] = [];
      row.replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, (_2: string, cell: string) => {
        cells.push(stripTags(cell).trim().replace(/\|/g, '\\|'));
        return '';
      });
      if (cells.length) rows.push(cells);
      return '';
    });
    if (rows.length === 0) return '';
    const sep = rows[0].map(() => '---');
    const lines = [
      `| ${rows[0].join(' | ')} |`,
      `| ${sep.join(' | ')} |`,
      ...rows.slice(1).map(r => `| ${r.join(' | ')} |`),
    ];
    return '\n' + lines.join('\n') + '\n';
  });

  // Headings
  for (let i = 6; i >= 1; i--) {
    s = s.replace(new RegExp(`<h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, 'gi'),
      (_: string, c: string) => `\n${'#'.repeat(i)} ${stripTags(c).trim()}\n`);
  }

  // Code blocks (pre+code before inline code)
  s = s.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, '\n```\n$1\n```\n');
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

  // Bold / italic (process before stripping remaining tags)
  s = s.replace(/<(?:b|strong)[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, '**$1**');
  s = s.replace(/<(?:i|em)[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, '_$1_');

  // Links
  s = s.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // Inline images: cid: references
  s = s.replace(/<img[^>]+src="cid:([^"]*)"[^>]*\/?>/gi, (_: string, cid: string) => {
    const filename = inlineImageMap.get(cid.trim()) ?? cid.trim();
    return `[📎 ${filename}]`;
  });
  // Other images: use alt text
  s = s.replace(/<img[^>]*alt="([^"]*)"[^>]*\/?>/gi, '[$1]');
  s = s.replace(/<img[^>]*\/?>/gi, '');

  // Unordered lists
  s = s.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_: string, content: string) =>
    content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_2: string, item: string) =>
      `- ${stripTags(item).trim()}\n`));

  // Ordered lists
  s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_: string, content: string) => {
    let n = 0;
    return content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_2: string, item: string) =>
      `${++n}. ${stripTags(item).trim()}\n`);
  });

  // Paragraphs / line breaks
  s = s.replace(/<\/p>/gi, '\n\n').replace(/<p[^>]*>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');

  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, '');

  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}
```

- [ ] **Step 4: Run tests — confirm they all pass**

```bash
npm test -- htmlToMarkdown
```
Expected: all 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/htmlToMarkdown.ts src/test/htmlToMarkdown.test.ts
git commit -m "feat: add htmlToMarkdown utility with full test coverage"
```

---

### Task 12: `IOutlookClient` interface and types

**Files:**
- Create: `src/outlook/IOutlookClient.ts`

- [ ] **Step 1: Create `src/outlook/IOutlookClient.ts`**

```typescript
export interface FolderItem {
  id: string;
  displayName: string;
  unreadItemCount: number;
}

export interface EmailListItem {
  id: string;
  subject: string;
  receivedDateTime: string;  // ISO 8601
  senderName: string;
}

export interface EmailAttachment {
  name: string;
  contentType: string;
  contentBytes: string;  // base64
  isInline: boolean;
  contentId?: string;    // matches cid: references in HTML body
}

export interface EmailMessage extends EmailListItem {
  bodyHtml: string;      // empty string when email is plain-text only
  bodyText: string;      // plain-text body (always present)
  attachments: EmailAttachment[];
}

export interface IOutlookClient {
  listFolders(): Promise<FolderItem[]>;
  listEmails(folderId: string, limit: number): Promise<EmailListItem[]>;
  getEmail(emailId: string): Promise<EmailMessage>;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run compile
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/outlook/IOutlookClient.ts
git commit -m "feat: add IOutlookClient interface and email types"
```

---

### Task 13: `OutlookService` — tests first, then implementation

**Files:**
- Create: `src/test/mocks/MockOutlookClient.ts`
- Create: `src/test/OutlookService.test.ts`
- Create: `src/services/OutlookService.ts`

- [ ] **Step 1: Create `src/test/mocks/MockOutlookClient.ts`**

```typescript
import type { IOutlookClient, FolderItem, EmailListItem, EmailMessage } from '../../outlook/IOutlookClient';

export const MOCK_FOLDERS: FolderItem[] = [
  { id: 'folder-inbox', displayName: 'Inbox', unreadItemCount: 5 },
  { id: 'folder-support', displayName: 'Support', unreadItemCount: 2 },
];

export const MOCK_EMAIL_LIST: EmailListItem[] = [
  { id: 'email-1', subject: 'Login failing on mobile', receivedDateTime: '2026-05-20T10:00:00Z', senderName: 'Alice Smith' },
  { id: 'email-2', subject: 'Payment timeout error', receivedDateTime: '2026-05-19T09:00:00Z', senderName: 'Bob Jones' },
];

export const MOCK_EMAIL_HTML: EmailMessage = {
  id: 'email-1',
  subject: 'Login failing on mobile',
  receivedDateTime: '2026-05-20T10:00:00Z',
  senderName: 'Alice Smith',
  bodyHtml: '<h1>Bug Report</h1><p>Steps to reproduce:<br/>1. Open app<br/>2. Tap Login</p><img src="cid:img001@host" />',
  bodyText: 'Bug Report\nSteps to reproduce:\n1. Open app\n2. Tap Login',
  attachments: [
    { name: 'screenshot.png', contentType: 'image/png', contentBytes: 'base64data', isInline: true, contentId: 'img001@host' },
    { name: 'log.txt', contentType: 'text/plain', contentBytes: 'base64log', isInline: false },
  ],
};

export const MOCK_EMAIL_PLAIN: EmailMessage = {
  id: 'email-2',
  subject: 'Payment timeout error',
  receivedDateTime: '2026-05-19T09:00:00Z',
  senderName: 'Bob Jones',
  bodyHtml: '',
  bodyText: 'The payment gateway is timing out after 30 seconds.',
  attachments: [],
};

export class MockOutlookClient implements IOutlookClient {
  async listFolders(): Promise<FolderItem[]> { return MOCK_FOLDERS; }
  async listEmails(_folderId: string, _limit: number): Promise<EmailListItem[]> { return MOCK_EMAIL_LIST; }
  async getEmail(emailId: string): Promise<EmailMessage> {
    if (emailId === 'email-2') return MOCK_EMAIL_PLAIN;
    return MOCK_EMAIL_HTML;
  }
}
```

- [ ] **Step 2: Write failing tests in `src/test/OutlookService.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { OutlookService } from '../services/OutlookService';
import { MockOutlookClient, MOCK_FOLDERS, MOCK_EMAIL_LIST } from './mocks/MockOutlookClient';

describe('OutlookService.listFoldersForDisplay', () => {
  it('returns a numbered markdown list with unread counts', async () => {
    const svc = new OutlookService(new MockOutlookClient());
    const result = await svc.listFoldersForDisplay();
    expect(result).toContain('1. Inbox (5 unread)');
    expect(result).toContain('2. Support (2 unread)');
    expect(result).toHaveLength(result.length); // sanity
  });

  it('returns the folder list used for selection', async () => {
    const svc = new OutlookService(new MockOutlookClient());
    const folders = await svc.getFolders();
    expect(folders).toEqual(MOCK_FOLDERS);
  });
});

describe('OutlookService.listEmailsForDisplay', () => {
  it('returns a numbered markdown list with date, subject, sender', async () => {
    const svc = new OutlookService(new MockOutlookClient());
    const result = await svc.listEmailsForDisplay('folder-inbox', 10);
    expect(result).toContain('1.');
    expect(result).toContain('Login failing on mobile');
    expect(result).toContain('Alice Smith');
    expect(result).toContain('2.');
    expect(result).toContain('Payment timeout error');
  });

  it('returns the email list for selection', async () => {
    const svc = new OutlookService(new MockOutlookClient());
    const emails = await svc.getEmails('folder-inbox', 10);
    expect(emails).toEqual(MOCK_EMAIL_LIST);
  });
});

describe('OutlookService.fetchEmailForTicket', () => {
  it('converts HTML body to Markdown and builds inline image map', async () => {
    const svc = new OutlookService(new MockOutlookClient());
    const result = await svc.fetchEmailForTicket('email-1');
    expect(result.subject).toBe('Login failing on mobile');
    expect(result.markdownBody).toContain('# Bug Report');
    expect(result.markdownBody).toContain('[📎 screenshot.png]');
    expect(result.inlineImageMap).toEqual({ 'img001@host': 'screenshot.png' });
    expect(result.attachments).toHaveLength(2);
  });

  it('uses plain-text body when HTML is empty', async () => {
    const svc = new OutlookService(new MockOutlookClient());
    const result = await svc.fetchEmailForTicket('email-2');
    expect(result.markdownBody).toBe('The payment gateway is timing out after 30 seconds.');
    expect(result.inlineImageMap).toEqual({});
  });
});
```

- [ ] **Step 3: Run failing tests**

```bash
npm test -- OutlookService
```
Expected: fail with "Cannot find module '../services/OutlookService'".

- [ ] **Step 4: Implement `src/services/OutlookService.ts`**

```typescript
import type { IOutlookClient, FolderItem, EmailListItem, EmailAttachment } from '../outlook/IOutlookClient';
import { htmlToMarkdown } from '../utils/htmlToMarkdown';

export class OutlookService {
  constructor(private readonly client: IOutlookClient) {}

  async getFolders(): Promise<FolderItem[]> {
    return this.client.listFolders();
  }

  async listFoldersForDisplay(): Promise<string> {
    const folders = await this.client.listFolders();
    return folders
      .map((f, i) => `${i + 1}. ${f.displayName} (${f.unreadItemCount} unread)`)
      .join('\n');
  }

  async getEmails(folderId: string, limit: number): Promise<EmailListItem[]> {
    return this.client.listEmails(folderId, limit);
  }

  async listEmailsForDisplay(folderId: string, limit: number): Promise<string> {
    const emails = await this.client.listEmails(folderId, limit);
    return emails
      .map((e, i) => {
        const date = e.receivedDateTime.slice(0, 10);
        return `${i + 1}. [${date}] ${e.subject} (${e.senderName})`;
      })
      .join('\n');
  }

  async fetchEmailForTicket(emailId: string): Promise<{
    subject: string;
    markdownBody: string;
    inlineImageMap: Record<string, string>;
    attachments: EmailAttachment[];
  }> {
    const email = await this.client.getEmail(emailId);

    const inlineImageMap: Record<string, string> = {};
    for (const att of email.attachments) {
      if (att.isInline && att.contentId) {
        inlineImageMap[att.contentId] = att.name;
      }
    }

    let markdownBody: string;
    if (email.bodyHtml.trim()) {
      markdownBody = htmlToMarkdown(email.bodyHtml, new Map(Object.entries(inlineImageMap)));
    } else {
      markdownBody = email.bodyText;
    }

    return { subject: email.subject, markdownBody, inlineImageMap, attachments: email.attachments };
  }
}
```

- [ ] **Step 5: Run tests — confirm they all pass**

```bash
npm test -- OutlookService
```
Expected: all 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/outlook/IOutlookClient.ts src/services/OutlookService.ts src/test/mocks/MockOutlookClient.ts src/test/OutlookService.test.ts
git commit -m "feat: add OutlookService with htmlToMarkdown integration and tests"
```

---

### Task 14: `OutlookApiClient` (Microsoft Graph HTTP)

**Files:**
- Create: `src/outlook/OutlookApiClient.ts`

- [ ] **Step 1: Create `src/outlook/OutlookApiClient.ts`**

```typescript
import * as vscode from 'vscode';
import type { IOutlookClient, FolderItem, EmailListItem, EmailMessage, EmailAttachment } from './IOutlookClient';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0/me';
const SCOPES = ['https://graph.microsoft.com/Mail.Read'];

export class OutlookApiClient implements IOutlookClient {
  private async getToken(): Promise<string> {
    const session = await vscode.authentication.getSession('microsoft', SCOPES, { createIfNone: true });
    return session.accessToken;
  }

  private async fetch<T>(path: string): Promise<T> {
    const token = await this.getToken();
    const response = await fetch(`${GRAPH_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Graph API error ${response.status}: ${text}`);
    }
    return response.json() as Promise<T>;
  }

  async listFolders(): Promise<FolderItem[]> {
    const data = await this.fetch<{ value: Array<{ id: string; displayName: string; unreadItemCount: number }> }>(
      '/mailFolders?$select=id,displayName,unreadItemCount&$top=25',
    );
    return data.value.map(f => ({ id: f.id, displayName: f.displayName, unreadItemCount: f.unreadItemCount }));
  }

  async listEmails(folderId: string, limit: number): Promise<EmailListItem[]> {
    const data = await this.fetch<{ value: Array<{ id: string; subject: string; receivedDateTime: string; from: { emailAddress: { name: string } } }> }>(
      `/mailFolders/${encodeURIComponent(folderId)}/messages?$select=id,subject,receivedDateTime,from&$top=${limit}&$orderby=receivedDateTime desc`,
    );
    return data.value.map(m => ({
      id: m.id,
      subject: m.subject ?? '(no subject)',
      receivedDateTime: m.receivedDateTime,
      senderName: m.from?.emailAddress?.name ?? 'Unknown',
    }));
  }

  async getEmail(emailId: string): Promise<EmailMessage> {
    const m = await this.fetch<{
      id: string; subject: string; receivedDateTime: string;
      from: { emailAddress: { name: string } };
      body: { contentType: string; content: string };
      attachments?: Array<{
        '@odata.type': string; name: string; contentType: string;
        contentBytes: string; isInline: boolean; contentId?: string;
      }>;
    }>(`/messages/${encodeURIComponent(emailId)}?$expand=attachments`);

    const isHtml = m.body.contentType.toLowerCase() === 'html';
    const attachments: EmailAttachment[] = (m.attachments ?? [])
      .filter(a => a['@odata.type'] === '#microsoft.graph.fileAttachment')
      .map(a => ({
        name: a.name,
        contentType: a.contentType,
        contentBytes: a.contentBytes,
        isInline: a.isInline,
        contentId: a.contentId,
      }));

    return {
      id: m.id,
      subject: m.subject ?? '(no subject)',
      receivedDateTime: m.receivedDateTime,
      senderName: m.from?.emailAddress?.name ?? 'Unknown',
      bodyHtml: isHtml ? m.body.content : '',
      bodyText: isHtml ? '' : m.body.content,
      attachments,
    };
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run compile
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/outlook/OutlookApiClient.ts
git commit -m "feat: add OutlookApiClient using Microsoft Graph API and VS Code auth"
```

---

### Task 15: `uploadAttachment` on Jira client

**Files:**
- Modify: `src/jira/IJiraClient.ts`
- Modify: `src/jira/JiraApiClient.ts`
- Modify: `src/test/mocks/MockJiraClient.ts`

- [ ] **Step 1: Add `uploadAttachment` to `IJiraClient` interface**

In `src/jira/IJiraClient.ts`, add to the `IJiraClient` interface:
```typescript
uploadAttachment(issueKey: string, filename: string, contentType: string, contentBytes: string): Promise<void>;
```

- [ ] **Step 2: Implement in `JiraApiClient`**

Add the method to the `JiraApiClient` class. Place it after the existing `addComment` method:

```typescript
async uploadAttachment(issueKey: string, filename: string, contentType: string, contentBytes: string): Promise<void> {
  const url = `${this.baseUrl}/rest/api/2/issue/${issueKey}/attachments`;
  const buffer = Buffer.from(contentBytes, 'base64');
  const boundary = `----boundary${Date.now()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: this.authHeader,
      'X-Atlassian-Token': 'nocheck',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Attachment upload failed (${response.status}): ${text}`);
  }
}
```

Note: `this.authHeader` — check the existing pattern in `JiraApiClient` for how the auth header string is built and use the same field/getter.

- [ ] **Step 3: Add stub to `MockJiraClient`**

```typescript
async uploadAttachment(_issueKey: string, _filename: string, _contentType: string, _contentBytes: string): Promise<void> {
  // no-op in tests
}
```

- [ ] **Step 4: Verify compile and tests**

```bash
npm run compile && npm test
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/jira/IJiraClient.ts src/jira/JiraApiClient.ts src/test/mocks/MockJiraClient.ts
git commit -m "feat: add uploadAttachment to IJiraClient and JiraApiClient"
```

---

### Task 16: VS Code settings and `ConfigService`

**Files:**
- Modify: `package.json`
- Modify: `src/services/ConfigService.ts`

- [ ] **Step 1: Add Outlook settings to `package.json` contributions**

Find the `"properties"` block of the jira configuration group and add after the last Jira property (before the closing `}`):

```json
"ticketSidekick.outlook.folderId": {
  "type": "string",
  "default": "",
  "description": "Microsoft Graph folder ID to list emails from. Leave empty to be prompted on first use. Clear to re-run the folder picker."
},
"ticketSidekick.outlook.emailListSize": {
  "type": "number",
  "default": 10,
  "description": "Number of emails to show in the @jira create from email selection list."
}
```

- [ ] **Step 2: Add `getOutlookConfig` and `saveOutlookFolderId` to `ConfigService`**

```typescript
async getOutlookConfig(): Promise<{ folderId: string; emailListSize: number }> {
  const config = vscode.workspace.getConfiguration('ticketSidekick');
  return {
    folderId: config.get<string>('outlook.folderId') ?? '',
    emailListSize: config.get<number>('outlook.emailListSize') ?? 10,
  };
}

async saveOutlookFolderId(folderId: string): Promise<void> {
  await vscode.workspace.getConfiguration('ticketSidekick')
    .update('outlook.folderId', folderId, vscode.ConfigurationTarget.Global);
}
```

- [ ] **Step 3: Verify compile**

```bash
npm run compile
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add package.json src/services/ConfigService.ts
git commit -m "feat: add Outlook folder settings and ConfigService.getOutlookConfig"
```

---

### Task 17: New session types in `sessionState.ts`

**Files:**
- Modify: `src/participant/sessionState.ts`

- [ ] **Step 1: Add the three new session interfaces**

At the end of the interfaces section in `sessionState.ts` (before the first function), add:

```typescript
// --- Outlook email-to-ticket sessions ---

export interface FolderSelectionSession {
  folders: Array<{ id: string; displayName: string; unreadItemCount: number }>;
}

export interface EmailSelectionSession {
  folderId: string;
  emails: Array<{ id: string; subject: string; receivedDateTime: string; senderName: string }>;
}

export interface EmailContentSession {
  emailId: string;
  subject: string;
  markdownBody: string;
  inlineImageMap: Record<string, string>;
  attachments: Array<{
    name: string; contentType: string; contentBytes: string;
    isInline: boolean; contentId?: string;
  }>;
  selectedTemplateName: string | null;
  projectKey: string;
  issueType: string;
  additionalFields: Record<string, unknown>;
}
```

Note: Using inline types here (rather than importing from `IOutlookClient`) to keep `sessionState.ts` free from external coupling — it's supposed to be a pure VS Code-free types file.

- [ ] **Step 2: Verify compile and tests**

```bash
npm run compile && npm test
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/participant/sessionState.ts
git commit -m "feat: add FolderSelectionSession, EmailSelectionSession, EmailContentSession to sessionState"
```

---

### Task 18: `emailHandler.ts` — the chat flow

**Files:**
- Create: `src/participant/jira/emailHandler.ts`

> **Scope note:** Template selection is intentionally excluded from Phase 2. The existing `TemplateSelectionSession` handler routes to `handleCreateTicket`, not the email flow, so wiring it in would require a separate session type and adds scope. The ticket is created as issue type `Task`; template-driven fields can be applied afterward with `@jira set`. Templates can be added in a follow-up.

- [ ] **Step 1: Create `src/participant/jira/emailHandler.ts`**

```typescript
import * as vscode from 'vscode';
import { OutlookApiClient } from '../../outlook/OutlookApiClient';
import { OutlookService } from '../../services/OutlookService';
import type { TicketService } from '../../services/TicketService';
import type { ConfigService } from '../../services/ConfigService';
import type { IJiraClient } from '../../jira/IJiraClient';
import { markdownToJiraWiki } from '../../utils/markdownToJiraWiki';
import type { FolderSelectionSession, EmailSelectionSession, EmailContentSession } from '../sessionState';
import { isCancellation, isConfirmation } from '../sessionState';

export async function handleCreateFromEmail(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
  _jiraClient: IJiraClient,
  _ticketService: TicketService,
  configService: ConfigService,
  ws: vscode.Memento,
): Promise<void> {
  const outlookConfig = await configService.getOutlookConfig();
  const outlookService = new OutlookService(new OutlookApiClient());

  if (!outlookConfig.folderId) {
    let folders: Array<{ id: string; displayName: string; unreadItemCount: number }>;
    try {
      folders = await outlookService.getFolders();
    } catch (err) {
      stream.markdown(`**Could not list Outlook folders:** ${err instanceof Error ? err.message : String(err)}\n\nMake sure you are signed in to a Microsoft account in VS Code and have granted Mail.Read access.`);
      return;
    }
    const list = folders.map((f, i) => `${i + 1}. ${f.displayName} (${f.unreadItemCount} unread)`).join('\n');
    const session: FolderSelectionSession = { folders };
    await ws.update('jira.session.folderSelection', session);
    stream.markdown(`Which folder should I list emails from?\n\n${list}\n\nReply with a number to select, or **(c)** to cancel.\n\n<!-- jira:folder-selection -->`);
    return;
  }

  let emails: Array<{ id: string; subject: string; receivedDateTime: string; senderName: string }>;
  try {
    emails = await outlookService.getEmails(outlookConfig.folderId, outlookConfig.emailListSize);
  } catch (err) {
    stream.markdown(`**Could not list emails:** ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (emails.length === 0) {
    stream.markdown('No emails found in the configured folder.');
    return;
  }
  const list = await outlookService.listEmailsForDisplay(outlookConfig.folderId, outlookConfig.emailListSize);
  const session: EmailSelectionSession = { folderId: outlookConfig.folderId, emails };
  await ws.update('jira.session.emailSelection', session);
  stream.markdown(`${list}\n\nReply with a number to select an email, or **(c)** to cancel.\n\n<!-- jira:email-selection -->`);
}

export async function handleFolderSelection(
  reply: string,
  session: FolderSelectionSession,
  configService: ConfigService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  await ws.update('jira.session.folderSelection', undefined);
  if (isCancellation(reply)) { stream.markdown('_Cancelled._'); return; }
  const n = parseInt(reply.trim(), 10);
  if (isNaN(n) || n < 1 || n > session.folders.length) {
    await ws.update('jira.session.folderSelection', session);
    const list = session.folders.map((f, i) => `${i + 1}. ${f.displayName} (${f.unreadItemCount} unread)`).join('\n');
    stream.markdown(`Please reply with a number between 1 and ${session.folders.length}, or **(c)** to cancel.\n\n${list}\n\n<!-- jira:folder-selection -->`);
    return;
  }
  const chosen = session.folders[n - 1];
  await configService.saveOutlookFolderId(chosen.id);
  const outlookConfig = await configService.getOutlookConfig();
  const outlookService = new OutlookService(new OutlookApiClient());
  const emails = await outlookService.getEmails(chosen.id, outlookConfig.emailListSize);
  const emailList = await outlookService.listEmailsForDisplay(chosen.id, outlookConfig.emailListSize);
  const emailSession: EmailSelectionSession = { folderId: chosen.id, emails };
  await ws.update('jira.session.emailSelection', emailSession);
  stream.markdown(`Folder set to **${chosen.displayName}**.\n\n${emailList}\n\nReply with a number to select an email, or **(c)** to cancel.\n\n<!-- jira:email-selection -->`);
}

export async function handleEmailSelection(
  reply: string,
  session: EmailSelectionSession,
  stream: vscode.ChatResponseStream,
  configService: ConfigService,
  ws: vscode.Memento,
): Promise<void> {
  await ws.update('jira.session.emailSelection', undefined);
  if (isCancellation(reply)) { stream.markdown('_Cancelled._'); return; }
  const n = parseInt(reply.trim(), 10);
  if (isNaN(n) || n < 1 || n > session.emails.length) {
    await ws.update('jira.session.emailSelection', session);
    const list = session.emails.map((e, i) => `${i + 1}. [${e.receivedDateTime.slice(0, 10)}] ${e.subject} (${e.senderName})`).join('\n');
    stream.markdown(`Please reply with a number between 1 and ${session.emails.length}, or **(c)** to cancel.\n\n${list}\n\n<!-- jira:email-selection -->`);
    return;
  }
  const chosen = session.emails[n - 1];

  // Read project key from VS Code setting — required for ticket creation
  const projectKey = vscode.workspace.getConfiguration('ticketSidekick').get<string>('jira.defaultProject') ?? '';
  if (!projectKey) {
    stream.markdown('**No default project configured.** Set `ticketSidekick.jira.defaultProject` in VS Code settings and try again.');
    return;
  }

  stream.markdown(`_Fetching email…_`);
  const outlookService = new OutlookService(new OutlookApiClient());
  const { subject, markdownBody, inlineImageMap, attachments } = await outlookService.fetchEmailForTicket(chosen.id);

  const contentSession: EmailContentSession = {
    emailId: chosen.id, subject, markdownBody, inlineImageMap, attachments,
    selectedTemplateName: null, projectKey, issueType: 'Task', additionalFields: {},
  };
  await streamEmailContentPreview(contentSession, stream, ws);
}

export async function handleEmailContentSession(
  reply: string,
  session: EmailContentSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  if (isCancellation(reply)) {
    await ws.update('jira.session.emailContent', undefined);
    stream.markdown('_Cancelled._');
    return;
  }
  if (isConfirmation(reply)) {
    await ws.update('jira.session.emailContent', undefined);
    await finishEmailTicket(session, ticketService, stream);
    return;
  }
  stream.markdown(`_Reply **post it** to create the ticket or **(c)** to cancel._`);
  await streamEmailContentPreview(session, stream, ws);
}

async function streamEmailContentPreview(session: EmailContentSession, stream: vscode.ChatResponseStream, ws: vscode.Memento): Promise<void> {
  await ws.update('jira.session.emailContent', session);
  stream.markdown(
    `**Subject (summary):** ${session.subject}\n\n` +
    `**Description preview:**\n\n${session.markdownBody}\n\n` +
    `Reply **post it** to create the Jira ticket in **${session.projectKey}**, or **(c)** to cancel.\n\n<!-- jira:email-content -->`,
  );
}

async function finishEmailTicket(session: EmailContentSession, ticketService: TicketService, stream: vscode.ChatResponseStream): Promise<void> {
  let jiraWiki = markdownToJiraWiki(session.markdownBody);
  jiraWiki = jiraWiki.replace(/\[📎 ([^\]]+)\]/g, '!$1|thumbnail!');

  const result = await ticketService.createTicket(
    session.projectKey, session.subject, session.issueType,
    { ...session.additionalFields, description: jiraWiki },
  );
  stream.markdown(result);

  const keyMatch = result.match(/([A-Z][A-Z0-9]+-\d+)/);
  const issueKey = keyMatch?.[1];
  if (issueKey && session.attachments.length > 0) {
    await Promise.all(
      session.attachments.map(att =>
        ticketService.uploadAttachment(issueKey, att.name, att.contentType, att.contentBytes).catch(err => {
          stream.markdown(`_Warning: could not upload ${att.name}: ${err instanceof Error ? err.message : String(err)}_`);
        }),
      ),
    );
    stream.markdown(`\n\nUploaded ${session.attachments.length} attachment(s).\n\n<!-- @jira-ticket:${issueKey} -->`);
  } else if (issueKey) {
    stream.markdown(`\n\n<!-- @jira-ticket:${issueKey} -->`);
  }
}
```

- [ ] **Step 2: Add `uploadAttachment` delegation to `TicketService`**

In `src/services/TicketService.ts`, add after `addComment`:
```typescript
async uploadAttachment(issueKey: string, filename: string, contentType: string, contentBytes: string): Promise<void> {
  return this.client.uploadAttachment(issueKey, filename, contentType, contentBytes);
}
```

- [ ] **Step 3: Verify compile**

```bash
npm run compile
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/participant/jira/emailHandler.ts src/services/TicketService.ts
git commit -m "feat: add emailHandler with folder picker, email selection, preview, and ticket creation"
```

---

### Task 19: Wire email sessions and intent into `JiraParticipant.ts`

**Files:**
- Modify: `src/participant/JiraParticipant.ts`

- [ ] **Step 1: Add `'createFromEmail'` to the `Operation` union**

```typescript
type Operation =
  // ... existing operations ...
  | 'spellCheck'
  | 'createFromEmail';
```

- [ ] **Step 2: Add `createFromEmail` to `INTENT_PROMPT`**

Append inside the prompt string (import from `llmHelpers.ts` — update there):
```
- createFromEmail: create a Jira ticket from an Outlook email; triggered by "create from email", "ticket from email", "import email", "email to ticket"
```

- [ ] **Step 3: Import email handler functions**

```typescript
import {
  handleCreateFromEmail, handleFolderSelection, handleEmailSelection, handleEmailContentSession,
} from './jira/emailHandler';
import type { FolderSelectionSession, EmailSelectionSession, EmailContentSession } from './sessionState';
```

- [ ] **Step 4: Add session dispatch blocks in `createJiraParticipant`**

Add these three blocks in the session-dispatch section, after the `load-skipped` check and before the `comment list` check:

```typescript
if (lastResponse.includes('<!-- jira:folder-selection -->')) {
  const folderSession = ws.get<FolderSelectionSession>('jira.session.folderSelection');
  if (folderSession) {
    await handleFolderSelection(request.prompt, folderSession, configService, stream, ws);
    return;
  }
}

if (lastResponse.includes('<!-- jira:email-selection -->')) {
  const emailSession = ws.get<EmailSelectionSession>('jira.session.emailSelection');
  if (emailSession) {
    await handleEmailSelection(request.prompt, emailSession, stream, configService, ws);
    return;
  }
}

if (lastResponse.includes('<!-- jira:email-content -->')) {
  const contentSession = ws.get<EmailContentSession>('jira.session.emailContent');
  if (contentSession) {
    await handleEmailContentSession(request.prompt, contentSession, ticketService, stream, ws);
    return;
  }
}
```

- [ ] **Step 5: Add `createFromEmail` case to the intent dispatch switch**

```typescript
if (intent.operation === 'createFromEmail') {
  await handleCreateFromEmail(request, stream, token, jiraClient, ticketService, configService, ws);
  return;
}
```
Place this alongside the other early-exit intent checks (`createTicket`, `discoverWorkflow`, `runCleanup`).

- [ ] **Step 6: Verify compile and tests**

```bash
npm run compile && npm test
```
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/participant/JiraParticipant.ts
git commit -m "feat: wire Outlook email sessions and createFromEmail intent into JiraParticipant"
```

---

### Task 20: Update `CLAUDE.md` and `README.md`

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Update the Key files table in `CLAUDE.md`**

Add these rows:
```
| `src/outlook/IOutlookClient.ts` | All Outlook/Graph types + IOutlookClient interface |
| `src/outlook/OutlookApiClient.ts` | Real Microsoft Graph HTTP; auth via vscode.authentication |
| `src/services/OutlookService.ts` | Outlook business logic: list folders, list emails, fetch+convert email |
| `src/utils/htmlToMarkdown.ts` | Converts HTML email body to Markdown (cid: images → [📎 name] placeholders) |
| `src/participant/jira/emailHandler.ts` | Email-to-ticket chat flow (folder picker, email selection, preview, create) |
```

Update the `JiraParticipant.ts` entry to:
```
| `src/participant/JiraParticipant.ts` | Jira chat handler + intent routing; delegates to `src/participant/jira/` handlers |
```

- [ ] **Step 2: Update the Jira architecture diagram in `CLAUDE.md`**

Add the Outlook layer below the existing diagram:
```
OutlookService → IOutlookClient (interface)
                      ↓
              OutlookApiClient (Microsoft Graph HTTP, vscode.authentication)
              MockOutlookClient (test fixture)
```

- [ ] **Step 3: Update the session state table in `CLAUDE.md`**

Remove the `SpellCheckSession` row. Add:
```
| `FolderSelectionSession` | `jira.session.folderSelection` | `<!-- jira:folder-selection -->` |
| `EmailSelectionSession` | `jira.session.emailSelection` | `<!-- jira:email-selection -->` |
| `EmailContentSession` | `jira.session.emailContent` | `<!-- jira:email-content -->` |
```

Update the detection order line to include: `→ folder selection → email selection → email content → comment list → intent parse`.

- [ ] **Step 4: Update VS Code settings tables in `CLAUDE.md`**

Remove `ticketSidekick.jira.spellCheck`. Add under a new **Outlook settings** section:
```
| Folder ID | `ticketSidekick.outlook.folderId` |
| Email list size | `ticketSidekick.outlook.emailListSize` |
```

- [ ] **Step 5: Add user-facing section to `README.md`**

Add a new `## Create a ticket from Outlook email` section documenting:
- Trigger: `@jira create from email`
- First run: folder picker appears — reply with number to select, choice is saved
- Email selection: numbered list — reply with number
- Preview: Markdown preview in chat — reply **post it** to confirm or give a refinement instruction
- Spell check: use `@jira spell check PROJ-123` on any ticket's description on demand
- Settings: `ticketSidekick.outlook.folderId` (clear to re-run folder picker), `ticketSidekick.outlook.emailListSize`
- Auth: VS Code Microsoft sign-in (works with enterprise SSO / Kerberos transparently on domain-joined machines)

- [ ] **Step 6: Final test run**

```bash
npm run compile && npm test
```
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: update CLAUDE.md and README.md for spell check refactor and email-to-ticket feature"
```
