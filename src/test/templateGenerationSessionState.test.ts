import { describe, it, expect } from 'vitest';
import {
  filterOutPerTicketFields,
  buildTemplateFieldReviewRows,
  formatTemplateFieldValue,
  buildTemplateFieldReviewTable,
  buildEmptyRequiredFieldsWarning,
  findUnsetIncludedRows,
  buildDefaultFieldsFromRows,
  buildGeneratedTemplate,
  extractProjectKeyFromTicketKey,
  parseIssueTypePick,
  parseTemplateCollisionReply,
  parseOfferCreateReply,
  isExplicitCancelToken,
  parseAwaitFreeTextReply,
  applyReviewSetValue,
  isSessionExpired,
  CURRENT_SESSION_SCHEMA_VERSION,
  type TemplateFieldReviewRow,
  type TemplateGenerationAwaitNameSession,
  type TemplateGenerationAwaitFreeTypeSession,
} from '../participant/sessionState';
import type { TemplateFieldCandidate } from '../services/TicketService';

describe('filterOutPerTicketFields', () => {
  it('drops summary/description/issuetype/project/reporter but keeps template-shaped fields', () => {
    const candidates: TemplateFieldCandidate[] = [
      { id: 'summary', name: 'Summary' },
      { id: 'description', name: 'Description' },
      { id: 'issuetype', name: 'Issue Type' },
      { id: 'project', name: 'Project' },
      { id: 'reporter', name: 'Reporter' },
      { id: 'priority', name: 'Priority' },
      { id: 'labels', name: 'Labels' },
    ];
    expect(filterOutPerTicketFields(candidates)).toEqual([
      { id: 'priority', name: 'Priority' },
      { id: 'labels', name: 'Labels' },
    ]);
  });
});

describe('buildTemplateFieldReviewRows', () => {
  it('numbers rows starting at 1 in source order, carrying the real field id separately, defaulting included to true', () => {
    const candidates: TemplateFieldCandidate[] = [
      { id: 'priority', name: 'Priority', value: { name: 'High' } },
      { id: 'customfield_10020', name: 'Sprint', value: undefined },
    ];
    expect(buildTemplateFieldReviewRows(candidates)).toEqual([
      { id: '1', fieldId: 'priority', name: 'Priority', value: { name: 'High' }, included: true },
      { id: '2', fieldId: 'customfield_10020', name: 'Sprint', value: undefined, included: true },
    ]);
  });
});

describe('formatTemplateFieldValue', () => {
  it('renders a plain string as-is', () => {
    expect(formatTemplateFieldValue('High')).toBe('High');
  });

  it('renders an array by joining formatted elements', () => {
    expect(formatTemplateFieldValue(['billing', 'urgent'])).toBe('billing, urgent');
  });

  it('renders an object with a name as that name', () => {
    expect(formatTemplateFieldValue({ name: 'High' })).toBe('High');
  });

  it('renders an object with only an id as that id', () => {
    expect(formatTemplateFieldValue({ id: 42 })).toBe('42');
  });

  it('falls back to JSON for an object with neither name nor id', () => {
    expect(formatTemplateFieldValue({ foo: 'bar' })).toBe('{"foo":"bar"}');
  });

  it('renders undefined/null as an empty string', () => {
    expect(formatTemplateFieldValue(undefined)).toBe('');
    expect(formatTemplateFieldValue(null)).toBe('');
  });
});

describe('buildTemplateFieldReviewTable', () => {
  it('renders the not-set sentinel with the row-specific reply hint for an unset value', () => {
    const rows: TemplateFieldReviewRow[] = [
      { id: '1', fieldId: 'priority', name: 'Priority', value: undefined, included: true },
    ];
    const table = buildTemplateFieldReviewTable(rows);
    expect(table).toContain('_not set — reply `1=<value>`_');
  });

  it('renders a resolved value and the Include column state', () => {
    const rows: TemplateFieldReviewRow[] = [
      { id: '1', fieldId: 'priority', name: 'Priority', value: { name: 'High' }, included: true },
      { id: '2', fieldId: 'labels', name: 'Labels', value: ['billing'], included: false },
    ];
    const table = buildTemplateFieldReviewTable(rows);
    expect(table).toContain('| 1 | Priority | High | ✓ |');
    expect(table).toContain('| 2 | Labels | billing | _excluded_ |');
  });

  it('includes the setValue reply syntax in the footer', () => {
    const table = buildTemplateFieldReviewTable([]);
    expect(table).toContain('`<number>=<value>`');
    expect(table).toContain('post it');
  });
});

describe('buildEmptyRequiredFieldsWarning (R4)', () => {
  it('names the issue type and project, and covers both the zero-required-fields and no-permission cases without distinguishing them', () => {
    const warning = buildEmptyRequiredFieldsWarning('Bug', 'PROJ');
    expect(warning).toContain('Bug');
    expect(warning).toContain('PROJ');
    expect(warning).toContain('may mean the type has none');
    expect(warning).toContain('lack Create permission');
  });
});

describe('findUnsetIncludedRows', () => {
  it('returns only rows that are included and have no value', () => {
    const rows: TemplateFieldReviewRow[] = [
      { id: '1', fieldId: 'priority', name: 'Priority', value: undefined, included: true },
      { id: '2', fieldId: 'labels', name: 'Labels', value: ['billing'], included: true },
      { id: '3', fieldId: 'components', name: 'Components', value: undefined, included: false },
    ];
    expect(findUnsetIncludedRows(rows)).toEqual([rows[0]]);
  });

  it('returns an empty array when every included row has a value', () => {
    const rows: TemplateFieldReviewRow[] = [
      { id: '1', fieldId: 'priority', name: 'Priority', value: { name: 'High' }, included: true },
    ];
    expect(findUnsetIncludedRows(rows)).toEqual([]);
  });
});

describe('buildDefaultFieldsFromRows / buildGeneratedTemplate', () => {
  const rows: TemplateFieldReviewRow[] = [
    { id: '1', fieldId: 'priority', name: 'Priority', value: { name: 'High' }, included: true },
    { id: '2', fieldId: 'labels', name: 'Labels', value: ['billing'], included: false },
    { id: '3', fieldId: 'components', name: 'Components', value: undefined, included: true },
  ];

  it('excludes toggled-out rows and rows with no value', () => {
    expect(buildDefaultFieldsFromRows(rows)).toEqual({ priority: { name: 'High' } });
  });

  it('includes every candidate when nothing is toggled out and every value is set', () => {
    const allSet: TemplateFieldReviewRow[] = [
      { id: '1', fieldId: 'priority', name: 'Priority', value: { name: 'High' }, included: true },
      { id: '2', fieldId: 'labels', name: 'Labels', value: ['billing'], included: true },
    ];
    expect(buildDefaultFieldsFromRows(allSet)).toEqual({ priority: { name: 'High' }, labels: ['billing'] });
  });

  it('builds a JiraTemplate with a literal defaultFields map and no resolveFields', () => {
    const template = buildGeneratedTemplate('Billing Bug', 'Bug', rows);
    expect(template).toEqual({
      name: 'Billing Bug',
      issueType: 'Bug',
      defaultFields: { priority: { name: 'High' } },
    });
    expect(template.resolveFields).toBeUndefined();
  });

  it('coerces a hand-typed value into its schema-appropriate shape rather than saving a bare string', () => {
    const typedRows: TemplateFieldReviewRow[] = [
      { id: '1', fieldId: 'priority', name: 'Priority', value: 'High', included: true, schema: { type: 'priority' } },
      { id: '2', fieldId: 'labels', name: 'Labels', value: 'billing, urgent', included: true, schema: { type: 'array', items: 'string' } },
      { id: '3', fieldId: 'components', name: 'Components', value: 'Backend', included: true, schema: { type: 'array', items: 'component' } },
      { id: '4', fieldId: 'summary', name: 'Summary', value: 'plain text', included: true, schema: { type: 'string' } },
      { id: '5', fieldId: 'custom_9', name: 'No schema known', value: 'raw', included: true },
    ];
    expect(buildDefaultFieldsFromRows(typedRows)).toEqual({
      priority: { name: 'High' },
      labels: ['billing', 'urgent'],
      components: [{ name: 'Backend' }],
      summary: 'plain text',
      custom_9: 'raw',
    });
  });

  it('never coerces a value already in its real shape (a reference-ticket-sourced value, not hand-typed)', () => {
    const alreadyShapedRows: TemplateFieldReviewRow[] = [
      { id: '1', fieldId: 'labels', name: 'Labels', value: ['billing'], included: true, schema: { type: 'array', items: 'string' } },
      { id: '2', fieldId: 'customfield_10020', name: 'Sprint', value: { id: 42 }, included: true, schema: { type: 'array', custom: 'gh-sprint' } },
    ];
    expect(buildDefaultFieldsFromRows(alreadyShapedRows)).toEqual({
      labels: ['billing'],
      customfield_10020: { id: 42 },
    });
  });
});

describe('applyReviewSetValue', () => {
  it('sets the value on the matching row and leaves other rows untouched', () => {
    const rows: TemplateFieldReviewRow[] = [
      { id: '1', fieldId: 'priority', name: 'Priority', value: undefined, included: true },
      { id: '2', fieldId: 'labels', name: 'Labels', value: undefined, included: true },
    ];
    const updated = applyReviewSetValue(rows, '1', 'High');
    expect(updated.find(r => r.id === '1')!.value).toBe('High');
    expect(updated.find(r => r.id === '2')!.value).toBeUndefined();
  });

  it('does not flip included', () => {
    const rows: TemplateFieldReviewRow[] = [
      { id: '1', fieldId: 'priority', name: 'Priority', value: undefined, included: true },
    ];
    const updated = applyReviewSetValue(rows, '1', 'High');
    expect(updated[0].included).toBe(true);
  });
});

describe('extractProjectKeyFromTicketKey', () => {
  it('extracts the project key from a real ticket key', () => {
    expect(extractProjectKeyFromTicketKey('PROJ-123')).toBe('PROJ');
    expect(extractProjectKeyFromTicketKey('VSJI2-1')).toBe('VSJI2');
  });

  it('returns null for something that is not a ticket key', () => {
    expect(extractProjectKeyFromTicketKey('not-a-key')).toBeNull();
    expect(extractProjectKeyFromTicketKey('')).toBeNull();
  });
});

describe('parseIssueTypePick', () => {
  const types = [
    { id: '10001', name: 'Bug' },
    { id: '10002', name: 'Story' },
    { id: '10003', name: 'Task' },
  ];

  it('picks by number, returning the matched {id, name} entry', () => {
    expect(parseIssueTypePick('2', types)).toEqual({ id: '10002', name: 'Story' });
  });

  it('picks by exact name, case-insensitively, returning the matched {id, name} entry', () => {
    expect(parseIssueTypePick('bug', types)).toEqual({ id: '10001', name: 'Bug' });
  });

  it('recognizes cancellation', () => {
    expect(parseIssueTypePick('c', types)).toBe('cancel');
  });

  it('returns invalid for an out-of-range number or unrecognized text', () => {
    expect(parseIssueTypePick('99', types)).toBe('invalid');
    expect(parseIssueTypePick('nonsense', types)).toBe('invalid');
  });
});

describe('parseTemplateCollisionReply (R6)', () => {
  it('recognizes cancellation', () => {
    expect(parseTemplateCollisionReply('cancel')).toEqual({ action: 'cancel' });
  });

  it('recognizes an explicit overwrite confirmation', () => {
    expect(parseTemplateCollisionReply('yes')).toEqual({ action: 'overwrite' });
  });

  it('treats any other non-empty reply as a new template name', () => {
    expect(parseTemplateCollisionReply('Billing Bug v2')).toEqual({ action: 'rename', name: 'Billing Bug v2' });
  });

  it('returns invalid for an empty reply', () => {
    expect(parseTemplateCollisionReply('   ')).toEqual({ action: 'invalid' });
  });
});

describe('parseOfferCreateReply (R7)', () => {
  it('recognizes decline', () => {
    expect(parseOfferCreateReply('no')).toEqual({ action: 'decline' });
  });

  it('recognizes a bare confirmation as needing a summary next', () => {
    expect(parseOfferCreateReply('yes')).toEqual({ action: 'needSummary' });
  });

  it('treats any other non-empty reply as the summary, skipping the extra round-trip', () => {
    expect(parseOfferCreateReply('Fix the login bug')).toEqual({ action: 'create', summary: 'Fix the login bug' });
  });

  it('treats an empty reply as decline', () => {
    expect(parseOfferCreateReply('   ')).toEqual({ action: 'decline' });
  });
});

describe('isExplicitCancelToken (KTD3)', () => {
  it('recognizes "(c)", case-insensitively and trimmed', () => {
    expect(isExplicitCancelToken('(c)')).toBe(true);
    expect(isExplicitCancelToken('(C)')).toBe(true);
    expect(isExplicitCancelToken('  (c)  ')).toBe(true);
  });

  it('does not recognize isCancellation()\'s broader word list, e.g. "Stop" or "cancel"', () => {
    expect(isExplicitCancelToken('Stop')).toBe(false);
    expect(isExplicitCancelToken('cancel')).toBe(false);
    expect(isExplicitCancelToken('c')).toBe(false);
    expect(isExplicitCancelToken('no')).toBe(false);
  });
});

describe('parseAwaitFreeTextReply (R2/R3, KTD3)', () => {
  it('happy: treats a valid template name reply as a value to resume with', () => {
    expect(parseAwaitFreeTextReply('Billing Bug')).toEqual({ action: 'value', value: 'Billing Bug' });
  });

  it('happy: treats a valid free-text issue type reply as a value to resume with', () => {
    expect(parseAwaitFreeTextReply('Bug')).toEqual({ action: 'value', value: 'Bug' });
  });

  it('edge: an empty (or whitespace-only) reply is reported as empty, not a value', () => {
    expect(parseAwaitFreeTextReply('')).toEqual({ action: 'empty' });
    expect(parseAwaitFreeTextReply('   ')).toEqual({ action: 'empty' });
  });

  it('edge (KTD3): a reply of exactly "Stop" is accepted as a literal value, not cancellation', () => {
    expect(parseAwaitFreeTextReply('Stop')).toEqual({ action: 'value', value: 'Stop' });
  });

  it('cancellation: only an explicit "(c)" reply is recognized as cancellation', () => {
    expect(parseAwaitFreeTextReply('(c)')).toEqual({ action: 'cancel' });
    expect(parseAwaitFreeTextReply('(C)')).toEqual({ action: 'cancel' });
  });
});

describe('TemplateGenerationAwaitNameSession / TemplateGenerationAwaitFreeTypeSession expiry (R2/R3, KTD2)', () => {
  it('a stale schemaVersion on an await-name session is detected via isSessionExpired', () => {
    const stale: TemplateGenerationAwaitNameSession = {
      projectKeyHint: null, sourceTicketKey: null, issueTypeHint: null, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION - 1,
    };
    expect(isSessionExpired(stale)).toBe(true);
  });

  it('a current schemaVersion on an await-name session is not expired', () => {
    const current: TemplateGenerationAwaitNameSession = {
      projectKeyHint: 'PROJ', sourceTicketKey: null, issueTypeHint: null, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    };
    expect(isSessionExpired(current)).toBe(false);
  });

  it('a stale schemaVersion on an await-free-type session is detected via isSessionExpired', () => {
    const stale: TemplateGenerationAwaitFreeTypeSession = {
      templateName: 'Billing Bug', projectKey: 'PROJ', schemaVersion: CURRENT_SESSION_SCHEMA_VERSION - 1,
    };
    expect(isSessionExpired(stale)).toBe(true);
  });

  it('a current schemaVersion on an await-free-type session is not expired', () => {
    const current: TemplateGenerationAwaitFreeTypeSession = {
      templateName: 'Billing Bug', projectKey: 'PROJ', schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    };
    expect(isSessionExpired(current)).toBe(false);
  });
});
