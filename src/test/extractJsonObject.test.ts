import { describe, it, expect } from 'vitest';
import { extractJsonObject } from '../utils/extractJsonObject';

describe('extractJsonObject', () => {
  it('returns a bare JSON object unchanged', () => {
    const json = '{"operation":"getTicket","ticketKey":"PROJ-1"}';
    expect(extractJsonObject(json)).toBe(json);
  });

  it('strips a ```json fenced block', () => {
    const raw = '```json\n{"a":1}\n```';
    expect(extractJsonObject(raw)).toBe('{"a":1}');
  });

  it('extracts the first complete object when trailing prose contains braces', () => {
    // The old greedy /\{[\s\S]*\}/ grabbed through the final brace and broke JSON.parse.
    const raw = '{"operation":"getTicket","ticketKey":"PROJ-1"}\n\nNote: use {placeholder} later.';
    const extracted = extractJsonObject(raw);
    expect(extracted).toBe('{"operation":"getTicket","ticketKey":"PROJ-1"}');
    expect(() => JSON.parse(extracted!)).not.toThrow();
  });

  it('handles nested objects', () => {
    const raw = '{"a":{"b":{"c":1}}} trailing';
    expect(extractJsonObject(raw)).toBe('{"a":{"b":{"c":1}}}');
  });

  it('ignores braces inside string values', () => {
    const raw = '{"summary":"contains } a brace"} extra';
    expect(extractJsonObject(raw)).toBe('{"summary":"contains } a brace"}');
  });

  it('returns null when there is no object', () => {
    expect(extractJsonObject('no json here')).toBeNull();
  });
});
