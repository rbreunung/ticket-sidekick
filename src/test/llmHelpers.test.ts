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
    const model = makeModel('{"operation":"addEmailComment","ticketKey":"PROJ-1","projectKey":null}');
    const intent = await parseIntent('add this email to PROJ-1', model as never, {} as never);
    expect(intent).toEqual({ operation: 'addEmailComment', projectKey: null });
  });

  it('reads an operation that is not a report import as other', async () => {
    const model = makeModel('{"operation":"getTicket","ticketKey":"PROJ-1"}');
    const intent = await parseIntent('show PROJ-1', model as never, {} as never);
    expect(intent).toEqual({ operation: 'other', projectKey: null });
  });

  it('parses when the model appends trailing prose containing braces', async () => {
    // Previously the greedy /\{[\s\S]*\}/ swallowed the trailing brace and threw.
    const model = makeModel('{"operation":"importVeracode","projectKey":"PROJ"}\n\nNote: replace {value} as needed.');
    const intent = await parseIntent('import veracode report for PROJ', model as never, {} as never);
    expect(intent.operation).toBe('importVeracode');
    expect(intent.projectKey).toBe('PROJ');
  });

  it('retries once when the first reply is not valid JSON, then succeeds', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({ text: (async function* () { yield 'sorry, I cannot help with that'; })() })
      .mockResolvedValueOnce({ text: (async function* () { yield '{"operation":"importWaltzReport"}'; })() });
    const model = { sendRequest };
    const intent = await parseIntent('import oss report', model as never, {} as never);
    expect(intent.operation).toBe('importWaltzReport');
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
