import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => {
  class MockMarkdownPart {
    constructor(public value: { value: string }) {}
  }
  class MockResponseTurn {
    response: MockMarkdownPart[];
    result: { metadata?: Record<string, unknown> };
    constructor(parts: Array<{ value: string }>, result: { metadata?: Record<string, unknown> } = {}) {
      this.response = parts.map((p) => new MockMarkdownPart(p));
      this.result = result;
    }
  }
  class MockRequestTurn {
    constructor(public prompt: string, public references: never[] = []) {}
  }
  return {
    ChatRequestTurn: MockRequestTurn,
    ChatResponseTurn: MockResponseTurn,
    ChatResponseMarkdownPart: MockMarkdownPart,
    window: { createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })) },
  };
});

import * as vscode from 'vscode';
import { getActiveJiraSession } from '../participant/jira/ticketContext';
import { streamNextSection } from '../participant/jira/createHandler';
import type { CreationSession } from '../participant/sessionState';

function makeContext(history: unknown[]): vscode.ChatContext {
  return { history } as unknown as vscode.ChatContext;
}

describe('getActiveJiraSession', () => {
  it('returns the session carried in the last response turn\'s result metadata', () => {
    const context = makeContext([
      new vscode.ChatResponseTurn([{ value: 'Please choose a resolution:' }], {
        metadata: { jiraSession: { kinds: ['resolution-selection'] } },
      }),
    ]);
    expect(getActiveJiraSession(context)).toEqual({ kinds: ['resolution-selection'] });
  });

  it('returns undefined when the last turn carries no session metadata', () => {
    const context = makeContext([
      new vscode.ChatResponseTurn([{ value: 'Here is your ticket.' }], {}),
    ]);
    expect(getActiveJiraSession(context)).toBeUndefined();
  });

  it('returns undefined for an empty history', () => {
    expect(getActiveJiraSession(makeContext([]))).toBeUndefined();
  });

  it('round-trips the exact kind, distinguishing an unrelated session kind', () => {
    const context = makeContext([
      new vscode.ChatResponseTurn([{ value: 'Please reply with a number:' }], {
        metadata: { jiraSession: { kinds: ['sprint-selection'] } },
      }),
    ]);
    const session = getActiveJiraSession(context);
    expect(session?.kinds).toContain('sprint-selection');
    expect(session?.kinds).not.toContain('resolution-selection');
  });

  it('round-trips multiple simultaneously active kinds', () => {
    const context = makeContext([
      new vscode.ChatResponseTurn([{ value: 'Comment loaded.' }], {
        metadata: { jiraSession: { kinds: ['more-comments', 'comment-list'] } },
      }),
    ]);
    expect(getActiveJiraSession(context)?.kinds).toEqual(['more-comments', 'comment-list']);
  });

  // U3: an end-to-end round trip through a real handler-file production site (not just a
  // hand-built metadata literal) — createHandler.ts's streamNextSection() produces the
  // 'creating' session, and the next turn's getActiveJiraSession() reads it back off history.
  it('resumes a session actually produced by a handler-file streaming function', async () => {
    const stream = { markdown: vi.fn() };
    const ws = { update: vi.fn(), get: vi.fn() };
    const session: CreationSession = {
      template: '', project: 'PROJ', summary: null, issueType: 'Bug',
      allSections: [], pending: ['__summary__'], answers: {}, fields: {},
    };

    const produced = await streamNextSection(session, stream as never, ws as never);
    const rendered = stream.markdown.mock.calls.map((c: [string]) => c[0]).join('');

    const context = makeContext([
      new vscode.ChatResponseTurn([{ value: rendered }], produced),
    ]);
    expect(getActiveJiraSession(context)?.kinds).toEqual(['creating']);
  });
});
