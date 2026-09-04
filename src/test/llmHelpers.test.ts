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
    LanguageModelChatMessage: {
      User: (text: string) => ({ role: 'user' as const, content: text }),
      Assistant: (text: string) => ({ role: 'assistant' as const, content: text }),
    },
    window: { createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })) },
  };
});

import * as vscode from 'vscode';
import { extractHistoryTurns, buildHistoryContext, extractLastAssistantText, generateContent, extractFixVersionFromPrompt, parseIntent, mapCommandToOperation, looksLikeUnfilledPlaceholder } from '../participant/jira/llmHelpers';

describe('parseIntent', () => {
  const makeModel = (output: string) => ({
    sendRequest: vi.fn().mockImplementation(() =>
      Promise.resolve({
        text: (async function* () {
          yield output;
        })(),
      }),
    ),
  });

  it('parses a clean JSON object', async () => {
    const model = makeModel('{"operation":"getTicket","ticketKey":"PROJ-1"}');
    const intent = await parseIntent('show PROJ-1', model as never, {} as never);
    expect(intent.operation).toBe('getTicket');
    expect(intent.ticketKey).toBe('PROJ-1');
  });

  it('parses when the model appends trailing prose containing braces', async () => {
    // Previously the greedy /\{[\s\S]*\}/ swallowed the trailing brace and threw.
    const model = makeModel('{"operation":"getTicket","ticketKey":"PROJ-1"}\n\nNote: replace {value} as needed.');
    const intent = await parseIntent('show PROJ-1', model as never, {} as never);
    expect(intent.operation).toBe('getTicket');
    expect(intent.ticketKey).toBe('PROJ-1');
  });

  it('retries once when the first reply is not valid JSON, then succeeds', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({ text: (async function* () { yield 'sorry, I cannot help with that'; })() })
      .mockResolvedValueOnce({ text: (async function* () { yield '{"operation":"getTicket","ticketKey":"PROJ-1"}'; })() });
    const model = { sendRequest };
    const intent = await parseIntent('show PROJ-1', model as never, {} as never);
    expect(intent.operation).toBe('getTicket');
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  it('throws after a second unparseable reply', async () => {
    const sendRequest = vi.fn().mockResolvedValue({ text: (async function* () { yield 'still not json'; })() });
    const model = { sendRequest };
    await expect(parseIntent('show PROJ-1', model as never, {} as never)).rejects.toThrow(
      'Model did not return a JSON object',
    );
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  it('parses a generateTemplate operation with a reference ticket key and template name', async () => {
    const model = makeModel('{"operation":"generateTemplate","ticketKey":"PROJ-123","templateName":"Billing Bug"}');
    const intent = await parseIntent('generate a template from PROJ-123 called "Billing Bug"', model as never, {} as never);
    expect(intent.operation).toBe('generateTemplate');
    expect(intent.ticketKey).toBe('PROJ-123');
    expect(intent.templateName).toBe('Billing Bug');
  });

  it('parses a generateTemplate operation for a project with no reference ticket and no issue type', async () => {
    const model = makeModel('{"operation":"generateTemplate","projectKey":"VSJI","templateName":"Feature Request","ticketKey":null,"issueType":null}');
    const intent = await parseIntent('generate a template for VSJI called "Feature Request"', model as never, {} as never);
    expect(intent.operation).toBe('generateTemplate');
    expect(intent.projectKey).toBe('VSJI');
    expect(intent.templateName).toBe('Feature Request');
    expect(intent.ticketKey).toBeNull();
    expect(intent.issueType).toBeNull();
  });
});

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

  it('excludes assistant turns carrying the load-skipped session (metadata-based, R1/R3)', () => {
    const history = [
      new vscode.ChatRequestTurn('load PROJ-1'),
      new vscode.ChatResponseTurn(
        [{ value: 'Ticket loaded.\n\nSkipped attachments:\n\n1. trace.trc — 120 MB\n\nReply with a number to download it anyway.' }],
        { metadata: { jiraSession: { kinds: ['load-skipped'] } } },
      ),
      new vscode.ChatRequestTurn('write a comment about the issue'),
    ];
    const turns = extractHistoryTurns({ history } as never);
    // Load response is noise — only the two user turns should appear
    expect(turns).toHaveLength(2);
    expect(turns.every((t) => t.role === 'user')).toBe(true);
  });

  it('excludes assistant turns carrying the previewing session (metadata-based, R1/R3)', () => {
    const history = [
      new vscode.ChatRequestTurn('write a comment'),
      new vscode.ChatResponseTurn(
        [{ value: 'Here is my draft.\n\nReply post it to confirm.' }],
        { metadata: { jiraSession: { kinds: ['previewing'] } } },
      ),
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
      new vscode.ChatResponseTurn(
        [{ value: 'Draft content.' }],
        { metadata: { jiraSession: { kinds: ['previewing'] } } },
      ),
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

  it('"history-recent" omits old turns that "history-full" includes', () => {
    // 12 turns total (6 pairs); serializeTurns 'recent' takes last 10, 'full' takes all 12
    const history = Array.from({ length: 6 }, (_, i) => [
      new vscode.ChatRequestTurn(`question ${i}`),
      new vscode.ChatResponseTurn([{ value: `answer ${i}` }]),
    ]).flat();

    const full = buildHistoryContext('history-full', { history } as never);
    const recent = buildHistoryContext('history-recent', { history } as never);

    // First pair only appears in full
    expect(full).toContain('question 0');
    expect(recent).not.toContain('question 0');

    // Last pair appears in both
    expect(full).toContain('question 5');
    expect(recent).toContain('question 5');
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

  it('skips assistant turns carrying the previewing session (metadata-based, R1/R3)', () => {
    const history = [
      new vscode.ChatResponseTurn([{ value: 'real answer' }]),
      new vscode.ChatResponseTurn([{ value: 'Draft.' }], { metadata: { jiraSession: { kinds: ['previewing'] } } }),
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

describe('extractFixVersionFromPrompt', () => {
  it('extracts a multi-word version in double quotes', () => {
    expect(extractFixVersionFromPrompt('@jira run cleanup "My Cleanup" in "My Version has Spaces"')).toBe('My Version has Spaces');
  });

  it('extracts a two-word version in double quotes', () => {
    expect(extractFixVersionFromPrompt('@jira close BILLING bugs in "Release 3.2"')).toBe('Release 3.2');
  });

  it('extracts a version in single quotes', () => {
    expect(extractFixVersionFromPrompt("@jira close PROJ bugs in 'Fix Version 3.2'")).toBe('Fix Version 3.2');
  });

  it('returns null when no "in <quoted>" pattern', () => {
    expect(extractFixVersionFromPrompt('@jira run cleanup "Close released bugs"')).toBeNull();
  });

  it('does not match the rule name that follows "cleanup" instead of "in"', () => {
    expect(extractFixVersionFromPrompt('@jira run cleanup "My Cleanup"')).toBeNull();
  });

  it('returns "released" for unquoted in released keyword', () => {
    expect(extractFixVersionFromPrompt('@jira run cleanup "My Rule" in released')).toBe('released');
  });

  it('returns "unreleased" for unquoted in unreleased keyword', () => {
    expect(extractFixVersionFromPrompt('@jira run cleanup "My Rule" in unreleased')).toBe('unreleased');
  });

  it('lowercases the keyword', () => {
    expect(extractFixVersionFromPrompt('@jira run cleanup "My Rule" in Released')).toBe('released');
  });

  it('quoted "released" takes priority over unquoted keyword — returns literal string', () => {
    expect(extractFixVersionFromPrompt('@jira run cleanup "My Rule" in "released"')).toBe('released');
  });

  it('passes through wildcard pattern from quoted string', () => {
    expect(extractFixVersionFromPrompt('@jira run cleanup "My Rule" in "Release*"')).toBe('Release*');
  });

  it('quoted string containing "released" as a word returns full quoted value', () => {
    expect(extractFixVersionFromPrompt('@jira run cleanup "My Rule" in "My Version has released in it"')).toBe('My Version has released in it');
  });
});

describe('mapCommandToOperation', () => {
  it('maps each U4 slash command to its forced operation', () => {
    expect(mapCommandToOperation('create')).toBe('createTicket');
    expect(mapCommandToOperation('view')).toBe('getTicket');
    expect(mapCommandToOperation('comment')).toBe('addComment');
    expect(mapCommandToOperation('field')).toBe('updateField');
    expect(mapCommandToOperation('move')).toBe('transition');
    expect(mapCommandToOperation('search')).toBe('searchJql');
    expect(mapCommandToOperation('load')).toBe('loadTicket');
  });

  it('returns undefined for "check" — it bypasses parseIntent entirely, not this map', () => {
    expect(mapCommandToOperation('check')).toBeUndefined();
  });

  it('returns undefined for an unknown command', () => {
    expect(mapCommandToOperation('notARealCommand')).toBeUndefined();
  });

  it('returns undefined when no command was given (plain-text prompt)', () => {
    expect(mapCommandToOperation(undefined)).toBeUndefined();
  });
});

describe('looksLikeUnfilledPlaceholder', () => {
  it('does not flag a normal value', () => {
    expect(looksLikeUnfilledPlaceholder('VSJI')).toBe(false);
  });

  it('flags the literal walkthrough placeholder tokens', () => {
    expect(looksLikeUnfilledPlaceholder('<PROJECT>')).toBe(true);
    expect(looksLikeUnfilledPlaceholder('<ISSUE_TYPE>')).toBe(true);
    expect(looksLikeUnfilledPlaceholder('<TYPE>')).toBe(true);
    expect(looksLikeUnfilledPlaceholder('<SUMMARY>')).toBe(true);
  });

  it('does not flag a real value that merely contains angle brackets', () => {
    expect(looksLikeUnfilledPlaceholder('<Urgent> Bug')).toBe(false);
  });

  it('does not flag null, undefined, or empty string', () => {
    expect(looksLikeUnfilledPlaceholder(null)).toBe(false);
    expect(looksLikeUnfilledPlaceholder(undefined)).toBe(false);
    expect(looksLikeUnfilledPlaceholder('')).toBe(false);
  });
});
