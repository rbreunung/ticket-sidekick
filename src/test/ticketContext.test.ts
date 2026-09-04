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
});
