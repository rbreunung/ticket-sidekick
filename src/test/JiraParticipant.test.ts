import { describe, it, expect } from 'vitest';
import { extractCreationSessionFromText } from '../participant/sessionState';

describe('extractCreationSessionFromText', () => {
  const validSession = {
    template: 'Billing App Bug',
    project: 'BILLING',
    summary: 'Login bug',
    issueType: 'Bug',
    allSections: ['Steps to reproduce', 'Expected behavior'],
    pending: ['Expected behavior'],
    answers: { 'Steps to reproduce': 'Click login' },
    fields: { priority: 'High' },
  };

  it('extracts session from a response containing the marker', () => {
    const text = `Got it.\n\n<!-- @jira-create:${JSON.stringify(validSession)} -->`;
    const result = extractCreationSessionFromText(text);
    expect(result?.template).toBe('Billing App Bug');
    expect(result?.pending).toEqual(['Expected behavior']);
    expect(result?.answers['Steps to reproduce']).toBe('Click login');
  });

  it('returns null when no marker is present', () => {
    expect(extractCreationSessionFromText('some response with no marker')).toBeNull();
  });

  it('returns null for a marker with malformed JSON', () => {
    expect(extractCreationSessionFromText('<!-- @jira-create:invalid json -->')).toBeNull();
  });

  it('extracts session from text with content before and after marker', () => {
    const text = `**Steps to reproduce** — describe steps\n\n<!-- @jira-create:${JSON.stringify(validSession)} -->\n\nExtra text`;
    const result = extractCreationSessionFromText(text);
    expect(result?.project).toBe('BILLING');
  });
});
