import { describe, it, expect } from 'vitest';
import { buildTemplateFromCandidates, formatTemplateFieldValue, nextFreeTemplateName } from '../templates/templateFromTicket';

// A template built from a reference ticket's fields, saved under a name no other template has.

describe('the name a new template is saved under', () => {
  it('is the name asked for when no template has it', () => {
    expect(nextFreeTemplateName('Payments bug', ['Bug', 'Story'])).toBe('Payments bug');
  });

  it('gets the lowest free number when the name is taken', () => {
    expect(nextFreeTemplateName('Bug', ['Bug'])).toBe('Bug (2)');
    expect(nextFreeTemplateName('Bug', ['Bug', 'Bug (2)'])).toBe('Bug (3)');
    expect(nextFreeTemplateName('Bug', ['Bug', 'Bug (3)'])).toBe('Bug (2)');
  });

  it('counts names as taken only when they match exactly, as the template file does', () => {
    expect(nextFreeTemplateName('Bug', ['bug'])).toBe('Bug');
  });
});

describe('a template built from a ticket', () => {
  it('sets every field taken from the ticket, with its value as Jira gave it', () => {
    const template = buildTemplateFromCandidates('Payments bug', 'Bug', [
      { id: 'priority', name: 'Priority', value: { name: 'High' }, schema: { type: 'priority' } },
      { id: 'components', name: 'Component/s', value: [{ name: 'Backend' }], schema: { type: 'array', items: 'component' } },
      { id: 'labels', name: 'Labels', value: ['payments'], schema: { type: 'array', items: 'string' } },
    ]);
    expect(template).toEqual({
      name: 'Payments bug',
      issueType: 'Bug',
      defaultFields: { priority: { name: 'High' }, components: [{ name: 'Backend' }], labels: ['payments'] },
    });
  });

  it('has no fields when the ticket had none worth copying', () => {
    expect(buildTemplateFromCandidates('Plain', 'Task', [])).toEqual({ name: 'Plain', issueType: 'Task', defaultFields: {} });
  });
});

describe('a field value as the confirmation shows it', () => {
  it('shows names and lists instead of raw JSON', () => {
    expect(formatTemplateFieldValue('High')).toBe('High');
    expect(formatTemplateFieldValue(['billing', 'urgent'])).toBe('billing, urgent');
    expect(formatTemplateFieldValue({ name: 'High' })).toBe('High');
    expect(formatTemplateFieldValue({ id: 42 })).toBe('42');
    expect(formatTemplateFieldValue({ foo: 'bar' })).toBe('{"foo":"bar"}');
    expect(formatTemplateFieldValue(null)).toBe('');
  });
});
