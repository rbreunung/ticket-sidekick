# Formatted Comments & "Show Comment N" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace plain-text ADF extraction with proper Markdown formatting and let users select individual comments by number after `@jira show` or `@jira get comments`.

**Architecture:** A new `markdownFormatter.ts` utility handles both Jira wiki markup (v2 API, via `jira2md`) and ADF JSON (v3 API, via a custom walker). `sessionState.ts` gets a `CommentListSession` type + two pure functions so they can be Vitest-tested. `JiraParticipant.ts` stores the session after synthesis, numbers the summaries, and handles a "show comment N" turn that displays the full formatted body.

**Tech Stack:** `jira2md` npm package (wiki markup → Markdown), TypeScript, Vitest, existing VS Code extension pattern.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `src/utils/markdownFormatter.ts` | `adfToMarkdown()` + `wikiToMarkdown()` |
| Create | `src/types/jira2md.d.ts` | TypeScript module declaration for `jira2md` |
| Create | `src/test/markdownFormatter.test.ts` | Tests for `adfToMarkdown` and `wikiToMarkdown` |
| Modify | `src/participant/sessionState.ts` | Add `CommentListSession`, `buildCommentListSession`, `parseCommentIndex` |
| Modify | `src/test/JiraParticipant.test.ts` | Tests for the new session-state functions |
| Modify | `src/services/TicketService.ts` | Use `adfToMarkdown` in `formatIssue` |
| Modify | `src/test/TicketService.test.ts` | Add rich-formatting test for `getTicket` |
| Modify | `src/participant/JiraParticipant.ts` | Numbered summaries, store session, "show comment N" handler |

---

## Task 1: `markdownFormatter.ts` — formatter utility + tests

**Files:**
- Create: `src/types/jira2md.d.ts`
- Create: `src/utils/markdownFormatter.ts`
- Create: `src/test/markdownFormatter.test.ts`

- [ ] **Step 1: Install `jira2md` as a production dependency**

```bash
npm install jira2md
```

Expected: `jira2md` appears under `"dependencies"` in `package.json`.

- [ ] **Step 2: Write the failing tests**

Create `src/test/markdownFormatter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { adfToMarkdown, wikiToMarkdown } from '../utils/markdownFormatter';

describe('wikiToMarkdown', () => {
  it('converts Jira wiki bold to markdown bold', () => {
    expect(wikiToMarkdown('*bold text*')).toContain('**bold text**');
  });

  it('converts Jira wiki monospace to inline code', () => {
    expect(wikiToMarkdown('{{mono}}')).toContain('`mono`');
  });

  it('converts a Jira code block to a fenced code block', () => {
    const result = wikiToMarkdown('{code:java}\nSystem.out.println();\n{code}');
    expect(result).toContain('```');
    expect(result).toContain('System.out.println();');
  });

  it('passes plain text through unchanged', () => {
    expect(wikiToMarkdown('plain text')).toContain('plain text');
  });
});

describe('adfToMarkdown', () => {
  describe('v2 string input (wiki markup)', () => {
    it('delegates to wikiToMarkdown for string input', () => {
      expect(adfToMarkdown('*bold*')).toContain('**bold**');
    });
  });

  describe('null / missing input', () => {
    it('returns empty string for null', () => {
      expect(adfToMarkdown(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(adfToMarkdown(undefined)).toBe('');
    });

    it('returns empty string for a non-object non-string', () => {
      expect(adfToMarkdown(42)).toBe('');
    });
  });

  describe('ADF paragraph', () => {
    it('renders a simple paragraph', () => {
      const node = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] },
        ],
      };
      expect(adfToMarkdown(node)).toBe('Hello world');
    });

    it('separates two paragraphs with a blank line', () => {
      const node = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] },
        ],
      };
      expect(adfToMarkdown(node)).toMatch(/First\n\nSecond/);
    });
  });

  describe('ADF text marks', () => {
    it('wraps strong mark in **', () => {
      const node = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'bold', marks: [{ type: 'strong' }] }] },
        ],
      };
      expect(adfToMarkdown(node)).toContain('**bold**');
    });

    it('wraps em mark in _', () => {
      const node = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'italic', marks: [{ type: 'em' }] }] },
        ],
      };
      expect(adfToMarkdown(node)).toContain('_italic_');
    });

    it('wraps code mark in backticks', () => {
      const node = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'fn()', marks: [{ type: 'code' }] }] },
        ],
      };
      expect(adfToMarkdown(node)).toContain('`fn()`');
    });

    it('wraps strike mark in ~~', () => {
      const node = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'old', marks: [{ type: 'strike' }] }] },
        ],
      };
      expect(adfToMarkdown(node)).toContain('~~old~~');
    });

    it('renders a link mark', () => {
      const node = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'click here',
                marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
              },
            ],
          },
        ],
      };
      expect(adfToMarkdown(node)).toContain('[click here](https://example.com)');
    });
  });

  describe('ADF heading', () => {
    it('renders h1 with one hash', () => {
      const node = {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        ],
      };
      expect(adfToMarkdown(node)).toContain('# Title');
    });

    it('renders h2 with two hashes', () => {
      const node = {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Section' }] },
        ],
      };
      expect(adfToMarkdown(node)).toContain('## Section');
    });
  });

  describe('ADF lists', () => {
    it('renders bullet list items with -', () => {
      const node = {
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Alpha' }] }] },
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Beta' }] }] },
            ],
          },
        ],
      };
      const result = adfToMarkdown(node);
      expect(result).toContain('- Alpha');
      expect(result).toContain('- Beta');
    });

    it('renders ordered list items with numbers', () => {
      const node = {
        type: 'doc',
        content: [
          {
            type: 'orderedList',
            content: [
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Step one' }] }] },
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Step two' }] }] },
            ],
          },
        ],
      };
      const result = adfToMarkdown(node);
      expect(result).toContain('1. Step one');
      expect(result).toContain('2. Step two');
    });
  });

  describe('ADF code block', () => {
    it('renders a fenced code block with language', () => {
      const node = {
        type: 'doc',
        content: [
          {
            type: 'codeBlock',
            attrs: { language: 'typescript' },
            content: [{ type: 'text', text: 'const x = 1;' }],
          },
        ],
      };
      const result = adfToMarkdown(node);
      expect(result).toContain('```typescript');
      expect(result).toContain('const x = 1;');
      expect(result).toContain('```');
    });

    it('renders a fenced code block without language', () => {
      const node = {
        type: 'doc',
        content: [
          {
            type: 'codeBlock',
            attrs: {},
            content: [{ type: 'text', text: 'some code' }],
          },
        ],
      };
      expect(adfToMarkdown(node)).toContain('```\nsome code\n```');
    });
  });

  describe('ADF misc nodes', () => {
    it('renders hardBreak as newline', () => {
      const node = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Line one' },
              { type: 'hardBreak' },
              { type: 'text', text: 'Line two' },
            ],
          },
        ],
      };
      expect(adfToMarkdown(node)).toContain('Line one\nLine two');
    });

    it('renders mention as @Name', () => {
      const node = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'mention', attrs: { text: 'Jane Doe' } }] },
        ],
      };
      expect(adfToMarkdown(node)).toContain('@Jane Doe');
    });

    it('renders blockquote with > prefix', () => {
      const node = {
        type: 'doc',
        content: [
          {
            type: 'blockquote',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] },
            ],
          },
        ],
      };
      expect(adfToMarkdown(node)).toContain('> quoted');
    });

    it('renders horizontal rule as ---', () => {
      const node = { type: 'doc', content: [{ type: 'rule' }] };
      expect(adfToMarkdown(node)).toContain('---');
    });

    it('falls back to extracting text for unknown node types', () => {
      const node = {
        type: 'doc',
        content: [
          {
            type: 'unknownFutureType',
            content: [{ type: 'text', text: 'fallback text' }],
          },
        ],
      };
      expect(adfToMarkdown(node)).toContain('fallback text');
    });
  });
});
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
npm test -- --reporter=verbose src/test/markdownFormatter.test.ts
```

Expected: all tests FAIL with `Cannot find module '../utils/markdownFormatter'`.

- [ ] **Step 4: Create the TypeScript declaration for `jira2md`**

Create `src/types/jira2md.d.ts`:

```typescript
declare module 'jira2md' {
  export function to_markdown(wiki: string): string;
  export function to_jira(md: string): string;
}
```

- [ ] **Step 5: Write `src/utils/markdownFormatter.ts`**

```typescript
import { to_markdown } from 'jira2md';

export function wikiToMarkdown(wikiMarkup: string): string {
  return to_markdown(wikiMarkup);
}

type AdfNode = {
  type?: string;
  text?: string;
  content?: unknown[];
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
};

export function adfToMarkdown(node: unknown): string {
  if (typeof node === 'string') return wikiToMarkdown(node);
  if (!node || typeof node !== 'object') return '';

  const n = node as AdfNode;

  switch (n.type) {
    case 'doc':
      return (n.content ?? []).map(adfToMarkdown).join('').trim();

    case 'paragraph': {
      const inner = (n.content ?? []).map(adfToMarkdown).join('');
      return inner ? inner + '\n\n' : '';
    }

    case 'text': {
      let text = n.text ?? '';
      for (const mark of (n.marks ?? [])) {
        switch (mark.type) {
          case 'strong': text = `**${text}**`; break;
          case 'em': text = `_${text}_`; break;
          case 'code': text = `\`${text}\``; break;
          case 'strike': text = `~~${text}~~`; break;
          case 'link': {
            const href = (mark.attrs?.href as string) ?? '';
            text = `[${text}](${href})`;
            break;
          }
        }
      }
      return text;
    }

    case 'hardBreak':
      return '\n';

    case 'heading': {
      const level = (n.attrs?.level as number) ?? 1;
      const text = (n.content ?? []).map(adfToMarkdown).join('');
      return `${'#'.repeat(level)} ${text}\n\n`;
    }

    case 'bulletList':
      return (n.content ?? [])
        .map((item) => `- ${adfToMarkdown(item).trim()}`)
        .join('\n') + '\n\n';

    case 'orderedList':
      return (n.content ?? [])
        .map((item, i) => `${i + 1}. ${adfToMarkdown(item).trim()}`)
        .join('\n') + '\n\n';

    case 'listItem':
      return (n.content ?? []).map(adfToMarkdown).join('').trim();

    case 'codeBlock': {
      const lang = (n.attrs?.language as string) ?? '';
      const code = (n.content ?? []).map(adfToMarkdown).join('');
      return `\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
    }

    case 'blockquote': {
      const inner = (n.content ?? []).map(adfToMarkdown).join('').trim();
      return inner.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n';
    }

    case 'rule':
      return '---\n\n';

    case 'mention':
      return `@${(n.attrs?.text as string) ?? 'unknown'}`;

    default:
      return (n.content ?? []).map(adfToMarkdown).join('');
  }
}
```

- [ ] **Step 6: Run tests to confirm they pass**

```bash
npm test -- --reporter=verbose src/test/markdownFormatter.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Run full test suite and compile**

```bash
npm test && npm run compile
```

Expected: all tests PASS, no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add src/types/jira2md.d.ts src/utils/markdownFormatter.ts src/test/markdownFormatter.test.ts package.json package-lock.json
git commit -m "feat: add markdownFormatter — adfToMarkdown (ADF+wiki) with jira2md"
```

---

## Task 2: Use `adfToMarkdown` in `TicketService.formatIssue`

**Files:**
- Modify: `src/services/TicketService.ts`
- Modify: `src/test/TicketService.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/test/TicketService.test.ts`, add inside the `describe('getTicket', ...)` block, after the existing tests:

```typescript
it('preserves ADF rich formatting (list items) in description', async () => {
  client.getIssue = async () => ({
    id: '1', key: 'PROJ-1',
    fields: {
      summary: 'Test', description: {
        type: 'doc', version: 1,
        content: [{
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item A' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item B' }] }] },
          ],
        }],
      },
      status: { name: 'Open' }, assignee: null, reporter: null,
      priority: null, labels: [], fixVersions: [], comment: null,
    },
  });
  const result = await service.getTicket('PROJ-1');
  expect(result).toContain('- Item A');
  expect(result).toContain('- Item B');
});
```

- [ ] **Step 2: Run the new test to confirm it fails**

```bash
npm test -- --reporter=verbose src/test/TicketService.test.ts
```

Expected: the new test FAILS — `extractTextFromAdf` produces `Item A Item B` without list markers.

- [ ] **Step 3: Update `src/services/TicketService.ts`**

Add the import at the top of the file (after the existing import):

```typescript
import { adfToMarkdown } from '../utils/markdownFormatter';
```

Change the `formatIssue` function — replace the `extractTextFromAdf` call in the description line:

```typescript
// BEFORE:
const description = f.description
  ? extractTextFromAdf(f.description).trim() || '_No description_'
  : '_No description_';

// AFTER:
const description = f.description
  ? adfToMarkdown(f.description).trim() || '_No description_'
  : '_No description_';
```

The `extractTextFromAdf` function and its export remain in `TicketService.ts` unchanged — it is still tested and used by callers that need plain text (e.g., future code that feeds content to an LLM without markup).

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: all tests PASS including the new formatting test.

- [ ] **Step 5: Compile**

```bash
npm run compile
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/TicketService.ts src/test/TicketService.test.ts
git commit -m "feat: use adfToMarkdown in formatIssue — preserves headings, lists, code blocks"
```

---

## Task 3: Add `CommentListSession`, `buildCommentListSession`, `parseCommentIndex` to `sessionState.ts`

**Files:**
- Modify: `src/participant/sessionState.ts`
- Modify: `src/test/JiraParticipant.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/test/JiraParticipant.test.ts`, add the following imports at the top (extend the existing import line):

```typescript
import {
  extractCreatedKeyFromConfirmation, extractLastTicketFromText,
  isConfirmation, isCancellation, serializeTurns, stripHiddenMarkers,
  parseTemplateSelection, parseIssueTypeSelection, parseSkipInput,
  parseResolutionSelection,
  // new:
  parseCommentIndex, buildCommentListSession,
} from '../participant/sessionState';
import type { TransitionBatchTicket } from '../participant/sessionState';
import type { JiraComment } from '../jira/IJiraClient';
```

Then append these test suites at the bottom of the file:

```typescript
describe('parseCommentIndex', () => {
  it('returns the number when reply is just a digit', () => {
    expect(parseCommentIndex('3', 5)).toBe(3);
  });

  it('extracts number from "show comment 3"', () => {
    expect(parseCommentIndex('show comment 3', 5)).toBe(3);
  });

  it('extracts number from "comment 2"', () => {
    expect(parseCommentIndex('comment 2', 5)).toBe(2);
  });

  it('extracts number from "full comment 4"', () => {
    expect(parseCommentIndex('full comment 4', 5)).toBe(4);
  });

  it('returns 1 for "first comment"… wait, only numeric', () => {
    expect(parseCommentIndex('first comment', 5)).toBe('invalid');
  });

  it('returns invalid when number exceeds maxIndex', () => {
    expect(parseCommentIndex('10', 5)).toBe('invalid');
  });

  it('returns invalid for 0', () => {
    expect(parseCommentIndex('0', 5)).toBe('invalid');
  });

  it('returns invalid when no digit present', () => {
    expect(parseCommentIndex('show me the comments', 5)).toBe('invalid');
  });

  it('returns invalid for empty string', () => {
    expect(parseCommentIndex('', 5)).toBe('invalid');
  });

  it('handles whitespace around the number', () => {
    expect(parseCommentIndex('  2  ', 5)).toBe(2);
  });
});

describe('buildCommentListSession', () => {
  const makeComment = (id: string, displayName: string, text: string, created: string): JiraComment => ({
    id,
    author: { accountId: id, displayName, emailAddress: `${id}@x.com` },
    body: {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    },
    created,
  });

  it('sets ticketKey on the session', () => {
    const session = buildCommentListSession('PROJ-42', []);
    expect(session.ticketKey).toBe('PROJ-42');
  });

  it('assigns 1-based indices', () => {
    const comments = [
      makeComment('1', 'Alice', 'First', '2024-01-01T00:00:00.000Z'),
      makeComment('2', 'Bob', 'Second', '2024-01-02T00:00:00.000Z'),
    ];
    const session = buildCommentListSession('PROJ-1', comments);
    expect(session.comments[0].index).toBe(1);
    expect(session.comments[1].index).toBe(2);
  });

  it('formats dates as YYYY-MM-DD', () => {
    const comments = [makeComment('1', 'Alice', 'Hi', '2024-03-15T09:30:00.000Z')];
    const session = buildCommentListSession('PROJ-1', comments);
    expect(session.comments[0].date).toBe('2024-03-15');
  });

  it('stores author display name', () => {
    const comments = [makeComment('1', 'Jane Doe', 'Hello', '2024-01-01T00:00:00.000Z')];
    const session = buildCommentListSession('PROJ-1', comments);
    expect(session.comments[0].author).toBe('Jane Doe');
  });

  it('converts ADF body to Markdown', () => {
    const comment: JiraComment = {
      id: '1',
      author: { accountId: 'a', displayName: 'Alice', emailAddress: 'a@x.com' },
      body: {
        type: 'doc', version: 1,
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'bold word', marks: [{ type: 'strong' }] }],
        }],
      },
      created: '2024-01-01T00:00:00.000Z',
    };
    const session = buildCommentListSession('PROJ-1', [comment]);
    expect(session.comments[0].bodyMarkdown).toContain('**bold word**');
  });

  it('converts wiki-markup body (v2 string) to Markdown', () => {
    const comment: JiraComment = {
      id: '1',
      author: { accountId: 'a', displayName: 'Alice', emailAddress: 'a@x.com' },
      body: '*bold*',
      created: '2024-01-01T00:00:00.000Z',
    };
    const session = buildCommentListSession('PROJ-1', [comment]);
    expect(session.comments[0].bodyMarkdown).toContain('**bold**');
  });

  it('falls back to _empty_ when body produces no text', () => {
    const comment: JiraComment = {
      id: '1',
      author: { accountId: 'a', displayName: 'Alice', emailAddress: 'a@x.com' },
      body: { type: 'doc', version: 1, content: [] },
      created: '2024-01-01T00:00:00.000Z',
    };
    const session = buildCommentListSession('PROJ-1', [comment]);
    expect(session.comments[0].bodyMarkdown).toBe('_empty_');
  });

  it('returns empty comments array when passed no comments', () => {
    const session = buildCommentListSession('PROJ-1', []);
    expect(session.comments).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- --reporter=verbose src/test/JiraParticipant.test.ts
```

Expected: new tests FAIL with `parseCommentIndex is not a function` / `buildCommentListSession is not a function`.

- [ ] **Step 3: Add types and functions to `src/participant/sessionState.ts`**

Add this import at the top of `sessionState.ts`:

```typescript
import type { JiraComment } from '../jira/IJiraClient';
import { adfToMarkdown } from '../utils/markdownFormatter';
```

Add the new interface and functions anywhere after the existing interfaces (e.g., after `ResolutionSelectionSession`):

```typescript
export interface CommentListSession {
  ticketKey: string;
  comments: Array<{
    index: number;
    author: string;
    date: string;
    bodyMarkdown: string;
  }>;
}

export function buildCommentListSession(ticketKey: string, comments: JiraComment[]): CommentListSession {
  return {
    ticketKey,
    comments: comments.map((c, i) => ({
      index: i + 1,
      author: c.author.displayName,
      date: c.created.slice(0, 10),
      bodyMarkdown: adfToMarkdown(c.body).trim() || '_empty_',
    })),
  };
}

export function parseCommentIndex(reply: string, maxIndex: number): number | 'invalid' {
  const match = reply.match(/\b(\d+)\b/);
  if (!match) return 'invalid';
  const n = parseInt(match[1], 10);
  if (n >= 1 && n <= maxIndex) return n;
  return 'invalid';
}
```

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: all tests PASS.

- [ ] **Step 5: Compile**

```bash
npm run compile
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/participant/sessionState.ts src/test/JiraParticipant.test.ts
git commit -m "feat: add CommentListSession, buildCommentListSession, parseCommentIndex to sessionState"
```

---

## Task 4: Wire everything up in `JiraParticipant.ts`

**Files:**
- Modify: `src/participant/JiraParticipant.ts`

This task has no new tests (JiraParticipant imports `vscode` and cannot be Vitest-tested; the pure logic it calls is already tested in Tasks 1–3). The verification is via compile + full test suite.

- [ ] **Step 1: Update imports at the top of `JiraParticipant.ts`**

Find the existing import from `'../services/TicketService'`:

```typescript
// BEFORE:
import { TicketService, assembleDescription, extractTextFromAdf } from '../services/TicketService';
```

Replace with:

```typescript
// AFTER:
import { TicketService, assembleDescription } from '../services/TicketService';
import { adfToMarkdown } from '../utils/markdownFormatter';
```

Find the existing import from `'./sessionState'` (it is a long single line). Add `CommentListSession`, `buildCommentListSession`, and `parseCommentIndex` to it:

```typescript
import {
  type CreationSession, type ContentSession, type MoreCommentsSession,
  type TemplateSelectionSession, type IssueTypeSelectionSession,
  type TransitionBatchSession, type TransitionBatchTicket, type TransitionSubtask,
  type ResolutionSelectionSession,
  type CommentListSession,                  // new
  extractCreatedKeyFromConfirmation, extractLastTicketFromText,
  stripHiddenMarkers, serializeTurns, isConfirmation, isCancellation,
  parseTemplateSelection, parseIssueTypeSelection, parseSkipInput,
  parseResolutionSelection,
  buildCommentListSession,                  // new
  parseCommentIndex,                        // new
} from './sessionState';
```

- [ ] **Step 2: Update `serializeCommentsForLLM` to use `adfToMarkdown`**

Find the function (currently calls `extractTextFromAdf`):

```typescript
// BEFORE:
function serializeCommentsForLLM(comments: JiraComment[]): string {
  return comments.map((c) => {
    const date = c.created.slice(0, 10);
    const body = extractTextFromAdf(c.body).trim() || '_empty_';
    return `**${c.author.displayName}** (${date}):\n${body}`;
  }).join('\n\n---\n\n');
}
```

Replace with:

```typescript
// AFTER:
function serializeCommentsForLLM(comments: JiraComment[]): string {
  return comments.map((c) => {
    const date = c.created.slice(0, 10);
    const body = adfToMarkdown(c.body).trim() || '_empty_';
    return `**${c.author.displayName}** (${date}):\n${body}`;
  }).join('\n\n---\n\n');
}
```

- [ ] **Step 3: Update `synthesizeComments` prompt to number the summaries**

Find the `synthesizeComments` function and change the no-query task string:

```typescript
// BEFORE:
const task = query
  ? `Find and quote comments relevant to: "${query}". Note the author and date for each relevant comment.`
  : 'Summarise each comment in one sentence. Format: **Author** (date): one-sentence summary.';

// AFTER:
const task = query
  ? `Find and quote comments relevant to: "${query}". Note the author and date for each relevant comment.`
  : 'Summarise each comment in one sentence. Number each one. Format: N. **Author** (date): one-sentence summary.';
```

- [ ] **Step 4: Add "show comment N" handler — insert before the `check` command block**

Find this line in the handler (it starts a standalone `if` block):

```typescript
if (/^check(\s+(config|connection|setup))?$/i.test(request.prompt.trim())) {
```

Insert the following block immediately before it:

```typescript
// Comment list — user replied with a comment number to view in full
if (lastResponse.includes('<!-- jira:comment-list -->')) {
  const commentSession = ws.get<CommentListSession>('jira.session.commentList');
  if (commentSession) {
    const index = parseCommentIndex(request.prompt, commentSession.comments.length);
    if (index !== 'invalid') {
      const entry = commentSession.comments[index - 1];
      stream.markdown(`**Comment ${index}** — ${entry.author} (${entry.date})\n\n${entry.bodyMarkdown}`);
      stream.markdown(`\n\n<!-- @jira-ticket:${commentSession.ticketKey} -->\n\n<!-- jira:comment-list -->`);
      return;
    }
    // Not a comment index — fall through to intent parse
  }
}
```

- [ ] **Step 5: Update the `more-comments` handler to store `CommentListSession`**

Find the existing `more-comments` handler block:

```typescript
if (lastResponse.includes('<!-- jira:more-comments -->') && isConfirmation(request.prompt)) {
  const session = ws.get<MoreCommentsSession>('jira.session.moreComments');
  if (session) {
    try {
      await ws.update('jira.session.moreComments', undefined);
      const { comments } = await ticketService.getIssueComments(session.ticketKey, 100);
      const synthesis = await synthesizeComments(
        serializeCommentsForLLM(comments),
        session.commentQuery,
        request.model,
        token,
      );
      stream.markdown(synthesis);
      stream.markdown(`\n\n<!-- @jira-ticket:${session.ticketKey} -->`);
    } catch (err) {
      stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
}
```

Replace with:

```typescript
if (lastResponse.includes('<!-- jira:more-comments -->') && isConfirmation(request.prompt)) {
  const session = ws.get<MoreCommentsSession>('jira.session.moreComments');
  if (session) {
    try {
      await ws.update('jira.session.moreComments', undefined);
      const { comments } = await ticketService.getIssueComments(session.ticketKey, 100);
      const synthesis = await synthesizeComments(
        serializeCommentsForLLM(comments),
        session.commentQuery,
        request.model,
        token,
      );
      if (!session.commentQuery) {
        await ws.update('jira.session.commentList', buildCommentListSession(session.ticketKey, comments));
      }
      stream.markdown(synthesis);
      const listTag = session.commentQuery ? '' : '\n\n<!-- jira:comment-list -->';
      stream.markdown(`\n\n<!-- @jira-ticket:${session.ticketKey} -->${listTag}`);
    } catch (err) {
      stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
}
```

- [ ] **Step 6: Update the `getComments` case inside the `switch` to store the session and emit the tag**

Find the `case 'getComments':` block:

```typescript
case 'getComments': {
  const MAX_INITIAL = 20;
  const { comments, total } = await ticketService.getIssueComments(ticketKey!, MAX_INITIAL);
  if (comments.length === 0) {
    result = `No comments on ${ticketKey}.`;
    break;
  }
  const synthesis = await synthesizeComments(
    serializeCommentsForLLM(comments),
    intent.commentQuery,
    request.model,
    token,
  );
  stream.markdown(synthesis);
  if (total > MAX_INITIAL) {
    const moreSession: MoreCommentsSession = { ticketKey: ticketKey!, commentQuery: intent.commentQuery };
    await ws.update('jira.session.moreComments', moreSession);
    stream.markdown(`\n\n_${total - MAX_INITIAL} older comment(s) not shown. Reply **"load all"** to include them._\n\n<!-- @jira-ticket:${ticketKey} -->\n\n<!-- jira:more-comments -->`);
  } else {
    stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->`);
  }
  return;
}
```

Replace with:

```typescript
case 'getComments': {
  const MAX_INITIAL = 20;
  const { comments, total } = await ticketService.getIssueComments(ticketKey!, MAX_INITIAL);
  if (comments.length === 0) {
    result = `No comments on ${ticketKey}.`;
    break;
  }
  const synthesis = await synthesizeComments(
    serializeCommentsForLLM(comments),
    intent.commentQuery,
    request.model,
    token,
  );
  const hasQuery = Boolean(intent.commentQuery);
  if (!hasQuery) {
    await ws.update('jira.session.commentList', buildCommentListSession(ticketKey!, comments));
  }
  stream.markdown(synthesis);
  const listTag = hasQuery ? '' : '\n\n<!-- jira:comment-list -->';
  if (total > MAX_INITIAL) {
    const moreSession: MoreCommentsSession = { ticketKey: ticketKey!, commentQuery: intent.commentQuery };
    await ws.update('jira.session.moreComments', moreSession);
    stream.markdown(`\n\n_${total - MAX_INITIAL} older comment(s) not shown. Reply **"load all"** to include them._\n\n<!-- @jira-ticket:${ticketKey} -->\n\n<!-- jira:more-comments -->${listTag}`);
  } else {
    stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->${listTag}`);
  }
  return;
}
```

- [ ] **Step 7: Update the `getTicket` case to store the session and emit the tag**

Find the `case 'getTicket':` block:

```typescript
case 'getTicket': {
  const base = await ticketService.getTicket(ticketKey!);
  const MAX_SHOW = 20;
  const { comments, total } = await ticketService.getIssueComments(ticketKey!, MAX_SHOW);
  stream.markdown(base);
  if (comments.length > 0) {
    const synthesis = await synthesizeComments(
      serializeCommentsForLLM(comments),
      null,
      request.model,
      token,
    );
    stream.markdown('\n\n**Comments:**\n\n' + synthesis);
    if (total > MAX_SHOW) {
      const moreSession: MoreCommentsSession = { ticketKey: ticketKey!, commentQuery: null };
      await ws.update('jira.session.moreComments', moreSession);
      stream.markdown(`\n\n_${total - MAX_SHOW} older comment(s) not shown. Reply **"load all"** to include them._\n\n<!-- @jira-ticket:${ticketKey} -->\n\n<!-- jira:more-comments -->`);
    } else {
      stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->`);
    }
    return;
  }
  result = base;
  break;
}
```

Replace with:

```typescript
case 'getTicket': {
  const base = await ticketService.getTicket(ticketKey!);
  const MAX_SHOW = 20;
  const { comments, total } = await ticketService.getIssueComments(ticketKey!, MAX_SHOW);
  stream.markdown(base);
  if (comments.length > 0) {
    const synthesis = await synthesizeComments(
      serializeCommentsForLLM(comments),
      null,
      request.model,
      token,
    );
    await ws.update('jira.session.commentList', buildCommentListSession(ticketKey!, comments));
    stream.markdown('\n\n**Comments:**\n\n' + synthesis);
    if (total > MAX_SHOW) {
      const moreSession: MoreCommentsSession = { ticketKey: ticketKey!, commentQuery: null };
      await ws.update('jira.session.moreComments', moreSession);
      stream.markdown(`\n\n_${total - MAX_SHOW} older comment(s) not shown. Reply **"load all"** to include them._\n\n<!-- @jira-ticket:${ticketKey} -->\n\n<!-- jira:more-comments -->\n\n<!-- jira:comment-list -->`);
    } else {
      stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->\n\n<!-- jira:comment-list -->`);
    }
    return;
  }
  result = base;
  break;
}
```

- [ ] **Step 8: Run all tests and compile**

```bash
npm test && npm run compile
```

Expected: all tests PASS (147+ tests), no TypeScript errors.

- [ ] **Step 9: Update `CLAUDE.md` session state table**

In `CLAUDE.md`, find the session state table and add this row:

```markdown
| `CommentListSession` | `jira.session.commentList` | `<!-- jira:comment-list -->` |
```

Also add `CommentListSession` to the detection order list:
> Detection order: resolution selection → transition review → template selection → issue type selection → creation → content → more-comments → **comment list** → intent parse.

- [ ] **Step 10: Commit**

```bash
git add src/participant/JiraParticipant.ts CLAUDE.md
git commit -m "feat: numbered comment summaries, store CommentListSession, handle 'show comment N'"
```

---

## Self-Review

**Spec coverage:**
- [x] `adfToMarkdown` handles paragraph, heading, bullet/ordered list, codeBlock, text marks (bold, italic, code, strike, link), hardBreak, mention, blockquote, rule, unknown fallback — all tested
- [x] `wikiToMarkdown` delegates to `jira2md` for v2 API strings — tested
- [x] `buildCommentListSession` converts comments to numbered indexed entries with formatted body — tested
- [x] `parseCommentIndex` extracts a 1-based number from natural language — tested
- [x] `getTicket` and `getComments` both emit `<!-- jira:comment-list -->` and store session
- [x] "show comment N" handler displays full formatted body and re-emits the tag (so user can view multiple)
- [x] `getComments` with a `commentQuery` does NOT store a comment list or emit the tag (no numbering for filtered results)
- [x] "load all" handler propagates comment list session after re-synthesis
- [x] `TicketService.formatIssue` uses `adfToMarkdown` for rich description rendering

**Placeholder scan:** No TBDs, no "handle edge cases" stubs. All code blocks are complete.

**Type consistency:** `CommentListSession.comments[].index` is `number` (1-based). `parseCommentIndex` returns `number | 'invalid'`. `buildCommentListSession` takes `JiraComment[]` — same type used throughout. `adfToMarkdown` takes `unknown` and returns `string` — same signature everywhere.
