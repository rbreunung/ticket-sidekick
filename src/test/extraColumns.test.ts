import { describe, it, expect } from 'vitest';
import type { JiraFieldMeta } from '../jira/IJiraClient';
import { MAX_EXTRA_VALUE_CHARS, renderExtraValue, resolveExtraColumns } from '../services/extraColumns';

const meta = (id: string, name: string, schema: JiraFieldMeta['schema'] = { type: 'string' }): JiraFieldMeta => ({ id, name, navigable: true, schema } as JiraFieldMeta);
const FIELDS = [meta('customfield_1', 'Team'), meta('labels', 'Labels', { type: 'array' }), meta('assignee', 'Assignee', { type: 'user' })];

function setup(fieldsOrError: JiraFieldMeta[] | Error = FIELDS) {
  const logs: Array<{ level: string; message: string; details?: unknown }> = [];
  let loads = 0;
  const loadMeta = async () => {
    loads++;
    if (fieldsOrError instanceof Error) throw fieldsOrError;
    return fieldsOrError;
  };
  const onDiag = (level: string, message: string, details?: unknown) => { logs.push({ level, message, details }); };
  return { logs, loadMeta, onDiag: onDiag as never, loads: () => loads };
}

describe('resolving the configured extra columns', () => {
  it('gives one column per id, titled with the field name', async () => {
    const s = setup();
    const columns = await resolveExtraColumns(['customfield_1', 'labels'], s.loadMeta, { setting: 'securityReportFields', builtIn: ['assignee'], onDiag: s.onDiag });
    expect(columns.map(c => [c.id, c.name])).toEqual([['customfield_1', 'Team'], ['labels', 'Labels']]);
  });

  it('adds no second column for a built-in id or a repeated id', async () => {
    const s = setup();
    const columns = await resolveExtraColumns(['customfield_1', 'assignee', 'customfield_1'], s.loadMeta, { setting: 'securityReportFields', builtIn: ['assignee'], onDiag: s.onDiag });
    expect(columns.map(c => c.id)).toEqual(['customfield_1']);
  });

  it('skips an unknown id and logs one warning naming it', async () => {
    const s = setup();
    const columns = await resolveExtraColumns(['customfield_9', 'customfield_1'], s.loadMeta, { setting: 'securityReportFields', onDiag: s.onDiag });
    expect(columns.map(c => c.id)).toEqual(['customfield_1']);
    expect(s.logs).toEqual([{ level: 'warn', message: 'Unrecognized field in securityReportFields: customfield_9', details: { fieldId: 'customfield_9' } }]);
  });

  it('keeps an unknown id as a column titled with the id when asked to', async () => {
    const s = setup();
    const columns = await resolveExtraColumns(['customfield_9'], s.loadMeta, { setting: 'searchFields', keepUnknown: true, onDiag: s.onDiag });
    expect(columns.map(c => [c.id, c.name])).toEqual([['customfield_9', 'customfield_9']]);
    expect(s.logs.map(l => l.message)).toEqual(['Unrecognized field in searchFields: customfield_9']);
  });

  it('never asks Jira for field names when nothing is left to resolve', async () => {
    const s = setup();
    expect(await resolveExtraColumns(undefined, s.loadMeta, { setting: 'securityReportFields' })).toEqual([]);
    expect(await resolveExtraColumns([], s.loadMeta, { setting: 'securityReportFields' })).toEqual([]);
    expect(await resolveExtraColumns(['assignee', '', '  ', 7], s.loadMeta, { setting: 'securityReportFields', builtIn: ['assignee'] })).toEqual([]);
    expect(s.loads()).toBe(0);
  });

  it('returns no extra columns and logs an error when the field names cannot be read', async () => {
    const s = setup(new Error('boom'));
    const columns = await resolveExtraColumns(['customfield_1'], s.loadMeta, { setting: 'securityReportFields', onDiag: s.onDiag });
    expect(columns).toEqual([]);
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0].level).toBe('error');
  });
});

describe('rendering an extra value', () => {
  const text = meta('customfield_1', 'Team');
  const list = meta('labels', 'Labels', { type: 'array' });
  const user = meta('customfield_2', 'Owner', { type: 'user' });

  it('shows every item of a list, joined with a semicolon', () => {
    expect(renderExtraValue(['a', 'b', 'c', 'd', 'e'].map(name => ({ name })), list)).toBe('a; b; c; d; e');
  });

  it('shows a plain value as the board shows it and a person by display name', () => {
    expect(renderExtraValue('Team 7', text)).toBe('Team 7');
    expect(renderExtraValue({ displayName: 'Dana' }, user)).toBe('Dana');
  });

  it('gives the raw empty string, not a word, when there is no value', () => {
    expect(renderExtraValue(null, text)).toBe('');
    expect(renderExtraValue(undefined, text)).toBe('');
    expect(renderExtraValue([], list)).toBe('');
    expect(renderExtraValue(null, user)).toBe('');
  });

  it('collapses line breaks and cuts a long value', () => {
    expect(renderExtraValue('one\n\n  two\tthree', text)).toBe('one two three');
    expect(renderExtraValue('x'.repeat(2000), text)).toHaveLength(MAX_EXTRA_VALUE_CHARS);
  });
});
