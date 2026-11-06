import { describe, it, expect } from 'vitest';
import { fieldValueToJira } from '../mcp/jiraTools/text';

describe('an update-field value as Jira receives it', () => {
  it('converts a Markdown description to Jira wiki markup', () => {
    expect(fieldValueToJira('Description', '## Goal\n\n- one\n- two')).toBe('h2. Goal\n\n* one\n* two');
  });

  it('leaves the summary and list-valued fields as written', () => {
    expect(fieldValueToJira('summary', '## not a heading')).toBe('## not a heading');
    expect(fieldValueToJira('labels', 'a, b')).toBe('a, b');
  });

  it('passes plain description text through unchanged', () => {
    expect(fieldValueToJira('description', 'The login works again.')).toBe('The login works again.');
  });
});
