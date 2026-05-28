import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => {
  class MockMarkdownPart {
    constructor(public value: { value: string }) {}
  }
  class MockResponseTurn {
    response: MockMarkdownPart[];
    constructor(parts: Array<{ value: string }>) {
      this.response = parts.map((p) => new MockMarkdownPart(p));
    }
  }
  class MockRequestTurn {
    constructor(public prompt: string, public references: never[] = []) {}
  }
  return {
    ChatRequestTurn: MockRequestTurn,
    ChatResponseTurn: MockResponseTurn,
    ChatResponseMarkdownPart: MockMarkdownPart,
    LanguageModelChatMessage: {
      User: (text: string) => ({ role: 'user' as const, content: text }),
      Assistant: (text: string) => ({ role: 'assistant' as const, content: text }),
    },
  };
});

import * as vscode from 'vscode';
import { extractHistoryTurns, buildHistoryContext, extractLastAssistantText, generateContent } from '../participant/jira/llmHelpers';

describe('extractHistoryTurns', () => {
  it('includes user turns', () => {
    const history = [new vscode.ChatRequestTurn('show PROJ-1')];
    const turns = extractHistoryTurns({ history } as never);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({ role: 'user', text: 'show PROJ-1' });
  });

  it('includes assistant turns without a preview marker', () => {
    const history = [
      new vscode.ChatResponseTurn([{ value: 'Here is the ticket.\n<!-- @jira-ticket:PROJ-1 -->' }]),
    ];
    const turns = extractHistoryTurns({ history } as never);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('assistant');
    expect(turns[0].text).toBe('Here is the ticket.'); // marker stripped
  });

  it('excludes assistant turns containing the jira:previewing marker', () => {
    const history = [
      new vscode.ChatRequestTurn('write a comment'),
      new vscode.ChatResponseTurn([{ value: 'Here is my draft.\n\nReply post it to confirm.\n\n<!-- jira:previewing -->' }]),
      new vscode.ChatRequestTurn('post it'),
    ];
    const turns = extractHistoryTurns({ history } as never);
    // Only the two user turns should appear — the preview draft is excluded
    expect(turns).toHaveLength(2);
    expect(turns.every((t) => t.role === 'user')).toBe(true);
    expect(turns[0].text).toBe('write a comment');
    expect(turns[1].text).toBe('post it');
  });

  it('includes the assistant turn after a confirmed preview (the final accepted response)', () => {
    const history = [
      new vscode.ChatRequestTurn('write a comment'),
      new vscode.ChatResponseTurn([{ value: 'Draft content.\n\n<!-- jira:previewing -->' }]),
      new vscode.ChatRequestTurn('post it'),
      new vscode.ChatResponseTurn([{ value: 'Comment posted to PROJ-1.\n\n<!-- @jira-ticket:PROJ-1 -->' }]),
    ];
    const turns = extractHistoryTurns({ history } as never);
    // Preview draft excluded; confirmation response included
    expect(turns).toHaveLength(3);
    const assistantTurns = turns.filter((t) => t.role === 'assistant');
    expect(assistantTurns).toHaveLength(1);
    expect(assistantTurns[0].text).toBe('Comment posted to PROJ-1.');
  });

  it('returns empty array for empty history', () => {
    expect(extractHistoryTurns({ history: [] } as never)).toEqual([]);
  });
});

describe('buildHistoryContext', () => {
  it('returns undefined for "generate" source', () => {
    const context = { history: [] } as never;
    expect(buildHistoryContext('generate', context)).toBeUndefined();
  });

  it('returns serialized recent turns for "history-recent" source', () => {
    const history = [
      new vscode.ChatRequestTurn('hello'),
      new vscode.ChatResponseTurn([{ value: 'world' }]),
    ];
    const result = buildHistoryContext('history-recent', { history } as never);
    expect(result).toContain('User: hello');
    expect(result).toContain('Assistant: world');
  });

  it('returns serialized full turns for "history-full" source', () => {
    const history = [
      new vscode.ChatRequestTurn('hello'),
      new vscode.ChatResponseTurn([{ value: 'world' }]),
    ];
    const result = buildHistoryContext('history-full', { history } as never);
    expect(result).toContain('User: hello');
    expect(result).toContain('Assistant: world');
  });
});

describe('extractLastAssistantText', () => {
  it('returns the last assistant turn text', () => {
    const history = [
      new vscode.ChatRequestTurn('first question'),
      new vscode.ChatResponseTurn([{ value: 'first answer' }]),
      new vscode.ChatRequestTurn('follow-up'),
      new vscode.ChatResponseTurn([{ value: 'second answer' }]),
    ];
    expect(extractLastAssistantText({ history } as never)).toBe('second answer');
  });

  it('skips assistant turns containing the jira:previewing marker', () => {
    const history = [
      new vscode.ChatResponseTurn([{ value: 'real answer' }]),
      new vscode.ChatResponseTurn([{ value: 'Draft.\n\n<!-- jira:previewing -->' }]),
    ];
    expect(extractLastAssistantText({ history } as never)).toBe('real answer');
  });

  it('returns empty string when no non-preview assistant turns exist', () => {
    const history = [new vscode.ChatRequestTurn('hello')];
    expect(extractLastAssistantText({ history } as never)).toBe('');
  });
});

describe('generateContent — role selection', () => {
  const makeModel = () => ({
    sendRequest: vi.fn().mockImplementation(() =>
      Promise.resolve({
        text: (async function* () {
          yield '';
        })(),
      }),
    ),
  });

  it('uses scribe role for history-full contentSource', async () => {
    const model = makeModel();
    await generateContent('write a summary', model as never, {} as never, undefined, 'history-full');
    const [messages] = model.sendRequest.mock.calls[0] as [Array<{ content: string }>];
    expect(messages[0].content).toContain('technical scribe');
  });

  it('uses Jira assistant role for generate contentSource', async () => {
    const model = makeModel();
    await generateContent('write something', model as never, {} as never, undefined, 'generate');
    const [messages] = model.sendRequest.mock.calls[0] as [Array<{ content: string }>];
    expect(messages[0].content).toContain('Jira assistant');
  });

  it('uses scribe role for history-recent contentSource', async () => {
    const model = makeModel();
    await generateContent('post the patch', model as never, {} as never, undefined, 'history-recent');
    const [messages] = model.sendRequest.mock.calls[0] as [Array<{ content: string }>];
    expect(messages[0].content).toContain('technical scribe');
  });
});
