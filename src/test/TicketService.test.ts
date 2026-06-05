import { describe, it, expect, beforeEach } from 'vitest';
import { TicketService, assembleDescription, extractTextFromAdf, resolveFieldIdFuzzy, formatIssueFields, renderFieldValue, isMultiLine } from '../services/TicketService';
import type { JiraAttachment, JiraFieldMeta, JiraIssue } from '../jira/IJiraClient';
import { MockJiraClient, FIXTURE_ATTACHMENT_BYTES } from './mocks/MockJiraClient';

describe('isMultiLine (#10 schema-driven section vs table)', () => {
  const meta = (id: string, custom?: string): JiraFieldMeta => ({
    id, name: id, navigable: true, schema: { type: 'string', ...(custom ? { custom } : {}) },
  });
  const longUrl = 'https://example.com/' + 'a'.repeat(140);

  it('puts a textarea custom field in its own section regardless of length', () => {
    expect(isMultiLine('short note', meta('customfield_1', 'com.atlassian...:textarea'))).toBe(true);
  });

  it('keeps a single-line text field inline even when the value is long', () => {
    expect(isMultiLine(longUrl, meta('customfield_2', 'com.atlassian...:textfield'))).toBe(false);
  });

  it('keeps a URL custom field inline even when long', () => {
    expect(isMultiLine(longUrl, meta('customfield_3', 'com.atlassian...:url'))).toBe(false);
  });

  it('treats the description and environment system fields as sections', () => {
    expect(isMultiLine('x', meta('description'))).toBe(true);
    expect(isMultiLine('x', meta('environment'))).toBe(true);
  });

  it('renders ADF/rich-content objects as a section', () => {
    expect(isMultiLine({ type: 'doc', content: [] }, meta('customfield_4'))).toBe(true);
  });

  it('falls back to a length heuristic for unknown plain-text fields', () => {
    expect(isMultiLine('a'.repeat(200), meta('customfield_5'))).toBe(true);
    expect(isMultiLine('short', meta('customfield_5'))).toBe(false);
  });
});

describe('TicketService', () => {
  let client: MockJiraClient;
  let service: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    service = new TicketService(client);
  });

  describe('getTicket', () => {
    it('returns formatted markdown with ticket details', async () => {
      const result = await service.getTicket('PROJ-123');
      expect(result).toContain('PROJ-123');
      expect(result).toContain('Implement user authentication');
      expect(result).toContain('Jane Doe');
      expect(result).toContain('High');
      expect(result).toContain('In Progress');
    });

    it('includes description text extracted from ADF', async () => {
      const result = await service.getTicket('PROJ-123');
      expect(result).toContain('OAuth2 authentication');
    });


    it('preserves ADF rich formatting (list items) in description', async () => {
      client.getIssue = async () => ({
        id: '1', key: 'PROJ-1',
        fields: {
          summary: 'Test', description: {
            type: 'doc', version: 1,
            content: [{
              type: 'bulletList',
              content: [
                { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item A' }] }] },
                { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item B' }] }] },
              ],
            }],
          },
          status: { name: 'Open' }, assignee: null, reporter: null,
          priority: null, labels: [], fixVersions: [], comment: null,
        },
      });
      const result = await service.getTicket('PROJ-1');
      expect(result).toContain('- Item A');
      expect(result).toContain('- Item B');
    });

    it('propagates not-found error for unknown ticket', async () => {
      await expect(service.getTicket('PROJ-404')).rejects.toThrow('Not found');
    });

    it('includes a clickable link in the heading when baseUrl is provided', async () => {
      const result = await service.getTicket('PROJ-123', undefined, undefined, undefined, 'https://jira.example.com');
      expect(result).toContain('[PROJ-123](https://jira.example.com/browse/PROJ-123)');
    });

    it('omits the link in the heading when baseUrl is absent', async () => {
      const result = await service.getTicket('PROJ-123');
      expect(result).toMatch(/^## PROJ-123:/m);
      expect(result).not.toContain('browse');
    });

    it('renders a Linked Issues section when issuelinks are present', async () => {
      const result = await service.getTicket('PROJ-123');
      expect(result).toContain('## Linked Issues');
      expect(result).toContain('blocks PROJ-45');
      expect(result).toContain('Auth login page');
      expect(result).toContain('Open');
    });

    it('makes linked issue keys clickable when baseUrl is provided', async () => {
      const result = await service.getTicket('PROJ-123', undefined, undefined, undefined, 'https://jira.example.com');
      expect(result).toContain('[PROJ-45](https://jira.example.com/browse/PROJ-45)');
    });

    it('renders a Web Links section when remote links are present', async () => {
      client.getRemoteLinks = async () => [
        { id: 1, object: { url: 'https://confluence.example.com/design', title: 'Auth Design' } },
      ];
      const result = await service.getTicket('PROJ-123');
      expect(result).toContain('## Web Links');
      expect(result).toContain('[Auth Design](https://confluence.example.com/design)');
    });

    it('omits Linked Issues and Web Links sections when both are absent', async () => {
      client.getIssue = async () => ({
        id: '2', key: 'PROJ-999',
        fields: {
          summary: 'Plain ticket', description: null, status: { name: 'Open' },
          assignee: null, reporter: null, priority: null, labels: [], fixVersions: [],
          comment: null,
        },
      });
      const result = await service.getTicket('PROJ-999');
      expect(result).not.toContain('## Linked Issues');
      expect(result).not.toContain('## Web Links');
    });

  });

  describe('addComment', () => {
    it('calls client with correct ticket key and body', async () => {
      await service.addComment('PROJ-123', 'Ready for review');
      expect(client.addCommentCalls).toHaveLength(1);
      expect(client.addCommentCalls[0]).toEqual({ issueKey: 'PROJ-123', body: 'Ready for review' });
    });

    it('returns confirmation message', async () => {
      const result = await service.addComment('PROJ-123', 'done');
      expect(result).toContain('PROJ-123');
      expect(result).toContain('comment');
    });
  });

  describe('updateField', () => {
    it('updates priority with correct Jira field format', async () => {
      await service.updateField('PROJ-123', 'priority', 'High');
      expect(client.updateIssueCalls[0]?.fields).toEqual({ priority: { name: 'High' } });
    });

    it('updates summary as plain string', async () => {
      await service.updateField('PROJ-123', 'summary', 'New title');
      expect(client.updateIssueCalls[0]?.fields).toEqual({ summary: 'New title' });
    });

    it('passes description as a plain string to the client', async () => {
      await service.updateField('PROJ-123', 'description', 'New desc');
      const fields = client.updateIssueCalls[0]?.fields;
      expect(fields?.description).toBe('New desc');
    });

    it('updates assignee by resolving user first', async () => {
      await service.updateField('PROJ-123', 'assignee', 'jane');
      expect(client.updateIssueCalls[0]?.fields).toEqual({ assignee: { accountId: 'abc123' } });
    });

    it('returns error message for unsupported field', async () => {
      const result = await service.updateField('PROJ-123', 'storypoints', '5');
      expect(result).toContain('not supported');
    });

    it('returns error message when assignee user not found', async () => {
      const result = await service.updateField('PROJ-123', 'assignee', 'nobody-unknown');
      expect(result).toContain('No user found');
    });

    it('assigns to current user when value is "me"', async () => {
      await service.updateField('PROJ-123', 'assignee', 'me');
      expect(client.updateIssueCalls[0]?.fields).toEqual({ assignee: { accountId: 'currentuser123' } });
    });

    it('assigns to current user when value is "myself"', async () => {
      await service.updateField('PROJ-123', 'assignee', 'myself');
      expect(client.updateIssueCalls[0]?.fields).toEqual({ assignee: { accountId: 'currentuser123' } });
    });

    it('uses name-based format when user has name but no accountId (Data Center)', async () => {
      client.findUser = async () => [{ name: 'jsmith', displayName: 'John Smith' }];
      await service.updateField('PROJ-123', 'assignee', 'John Smith');
      expect(client.updateIssueCalls[0]?.fields).toEqual({ assignee: { name: 'jsmith' } });
    });

    it('uses name-based format for current user when user has name but no accountId (Data Center)', async () => {
      client.getCurrentUser = async () => ({ name: 'jsmith', displayName: 'John Smith' });
      await service.updateField('PROJ-123', 'assignee', 'me');
      expect(client.updateIssueCalls[0]?.fields).toEqual({ assignee: { name: 'jsmith' } });
    });

    it('updates components with a single component name as array of name objects', async () => {
      await service.updateField('PROJ-123', 'components', 'Backend');
      expect(client.updateIssueCalls[0]?.fields).toEqual({ components: [{ name: 'Backend' }] });
    });

    it('updates components with multiple comma-separated names as array of name objects', async () => {
      await service.updateField('PROJ-123', 'components', 'Backend, API');
      expect(client.updateIssueCalls[0]?.fields).toEqual({ components: [{ name: 'Backend' }, { name: 'API' }] });
    });
  });

  describe('searchTickets', () => {
    it('returns formatted summary table', async () => {
      const result = await service.searchTickets('project = PROJ');
      expect(result).toContain('PROJ-123');
      expect(result).toContain('PROJ-124');
    });

    it('returns no-results message when empty', async () => {
      client.searchJql = async () => ({ issues: [], total: 0, maxResults: 20 });
      const result = await service.searchTickets('project = EMPTY');
      expect(result).toContain('No tickets found');
    });

    it('makes ticket keys clickable when baseUrl is provided', async () => {
      const result = await service.searchTickets('project = PROJ', 'https://jira.example.com');
      expect(result).toContain('[PROJ-123](https://jira.example.com/browse/PROJ-123)');
      expect(result).toContain('[PROJ-124](https://jira.example.com/browse/PROJ-124)');
    });

    it('omits links when baseUrl is absent', async () => {
      const result = await service.searchTickets('project = PROJ');
      expect(result).toContain('PROJ-123');
      expect(result).not.toContain('browse');
    });

    it('places View in Jira link above the table when baseUrl is provided', async () => {
      const result = await service.searchTickets('project = PROJ', 'https://jira.example.com');
      expect(result).toContain('[View in Jira](https://jira.example.com/issues/?jql=project%20%3D%20PROJ)');
      expect(result.indexOf('[View in Jira]')).toBeLessThan(result.indexOf('| Key |'));
    });

    it('omits View in Jira link when baseUrl is absent', async () => {
      const result = await service.searchTickets('project = PROJ');
      expect(result).not.toContain('[View in Jira]');
    });
  });

  describe('validateRequiredFields', () => {
    it('returns all-set message when all fields are present', async () => {
      const result = await service.validateRequiredFields('PROJ-123', ['summary', 'assignee', 'priority']);
      expect(result).toContain('All required fields are set');
    });

    it('reports missing fields', async () => {
      const result = await service.validateRequiredFields('PROJ-123', ['summary', 'fixVersions', 'nonexistent']);
      expect(result).toContain('nonexistent');
    });

    it('returns config guidance when no required fields configured', async () => {
      const result = await service.validateRequiredFields('PROJ-123', []);
      expect(result).toContain('ticketSidekick.jira.requiredFields');
    });
  });

  describe('resolveAssignee', () => {
    it('resolves "me" to the current user accountId', async () => {
      const result = await service.resolveAssignee('me');
      expect(result).toEqual({ accountId: 'currentuser123' });
    });

    it('resolves "myself" to the current user accountId', async () => {
      const result = await service.resolveAssignee('myself');
      expect(result).toEqual({ accountId: 'currentuser123' });
    });

    it('resolves a name to the matching user accountId', async () => {
      const result = await service.resolveAssignee('Jane');
      expect(result).toEqual({ accountId: 'abc123' });
    });

    it('returns an error string when no user is found', async () => {
      const result = await service.resolveAssignee('nobody');
      expect(typeof result).toBe('string');
      expect(result as string).toContain('No user found');
    });

    it('returns an error string when found user has neither name nor accountId', async () => {
      client.findUser = async () => [{ displayName: 'Ghost User' }];
      const result = await service.resolveAssignee('ghost');
      expect(typeof result).toBe('string');
      expect(result as string).toContain('no accountId or name');
    });

    it('returns an error string when current user has neither name nor accountId', async () => {
      client.getCurrentUser = async () => ({ displayName: 'Ghost Me' });
      const result = await service.resolveAssignee('me');
      expect(typeof result).toBe('string');
      expect(result as string).toContain('no accountId or name');
    });
  });

  describe('getIssueTypes', () => {
    it('returns non-subtask issue types for a project', async () => {
      const types = await service.getIssueTypes('PROJ');
      expect(types.length).toBeGreaterThan(0);
      expect(types.every((t) => !t.subtask)).toBe(true);
    });

    it('returns names as strings', async () => {
      const types = await service.getIssueTypes('PROJ');
      expect(types[0].name).toBe('Bug');
    });
  });

  describe('createTicket', () => {
    it('returns confirmation with the new ticket key', async () => {
      const result = await service.createTicket('PROJ', 'Login timeout bug', 'Bug');
      expect(result).toContain('PROJ-125');
    });

    it('includes the summary in the confirmation', async () => {
      const result = await service.createTicket('PROJ', 'Login timeout bug', 'Bug');
      expect(result).toContain('Login timeout bug');
    });
  });

  describe('getIssueComments', () => {
    it('returns comments array and total from fixture', async () => {
      const { comments, total } = await service.getIssueComments('PROJ-123');
      expect(comments).toHaveLength(1);
      expect(total).toBe(1);
      expect(comments[0].author.displayName).toBe('John Smith');
    });

    it('includes comment body and date in returned data', async () => {
      const { comments } = await service.getIssueComments('PROJ-123');
      expect(comments[0].created).toContain('2024-02-01');
    });

    it('returns empty array when ticket has no comments', async () => {
      client.getIssueComments = async () => ({ comments: [], total: 0 });
      const { comments, total } = await service.getIssueComments('PROJ-123');
      expect(comments).toHaveLength(0);
      expect(total).toBe(0);
    });

    it('passes maxResults through to the client', async () => {
      let capturedMax = 0;
      client.getIssueComments = async (_key, max) => { capturedMax = max; return { comments: [], total: 0 }; };
      await service.getIssueComments('PROJ-123', 5);
      expect(capturedMax).toBe(5);
    });
  });

  describe('assembleDescription', () => {
    it('formats sections in template order regardless of collection order', () => {
      const result = assembleDescription(
        ['Steps to reproduce', 'Expected behavior', 'Actual behavior'],
        {
          'Actual behavior': 'Got 404',
          'Steps to reproduce': 'Click login',
          'Expected behavior': 'Go to dashboard',
        },
      );
      expect(result).toBe(
        '**Steps to reproduce**\nClick login\n\n**Expected behavior**\nGo to dashboard\n\n**Actual behavior**\nGot 404',
      );
    });

    it('skips sections not yet present in answers', () => {
      const result = assembleDescription(
        ['Steps to reproduce', 'Expected behavior'],
        { 'Steps to reproduce': 'Click login' },
      );
      expect(result).toBe('**Steps to reproduce**\nClick login');
    });
  });

  describe('getOpenSubtasks', () => {
    it('returns only non-Done subtasks', async () => {
      const subtasks = await service.getOpenSubtasks('PROJ-123');
      expect(subtasks).toHaveLength(1);
      expect(subtasks[0].key).toBe('PROJ-124');
      expect(subtasks[0].currentStatus).toBe('In Progress');
    });
  });

  describe('transitionAlongPath', () => {
    it('calls executeTransition for each step', async () => {
      const path = [
        { id: '21', name: 'Submit for Review', to: 'In Review' },
        { id: '41', name: 'Approve', to: 'Done' },
      ];
      await service.transitionAlongPath('PROJ-123', path, 'Fixed');
      expect(client.executeTransitionCalls).toHaveLength(2);
      expect(client.executeTransitionCalls[0].fields).toBeUndefined();
      expect(client.executeTransitionCalls[1].fields).toEqual({ resolution: { name: 'Fixed' } });
    });

    it('works without resolution', async () => {
      const path = [{ id: '21', name: 'Submit for Review', to: 'In Review' }];
      await service.transitionAlongPath('PROJ-123', path);
      expect(client.executeTransitionCalls[0].fields).toBeUndefined();
    });

    it('retries without resolution when Jira rejects the resolution field with 400', async () => {
      let callCount = 0;
      client.executeTransition = async (_key, _id, fields) => {
        callCount++;
        if (fields && 'resolution' in fields) {
          throw new Error('Jira API error: 400 Bad Request — {"errors":{"resolution":"Field \'resolution\' cannot be set."}}');
        }
        client.executeTransitionCalls.push({ issueKey: _key, transitionId: _id, fields });
      };
      const path = [{ id: '41', name: 'Close', to: 'Done' }];
      await service.transitionAlongPath('PROJ-123', path, 'Fixed');
      expect(callCount).toBe(2);
      expect(client.executeTransitionCalls[0].fields).toBeUndefined();
    });

    it('does not retry for non-resolution 400 errors', async () => {
      client.executeTransition = async () => {
        throw new Error('Jira API error: 400 Bad Request — {"errors":{"status":"Invalid transition"}}');
      };
      const path = [{ id: '41', name: 'Close', to: 'Done' }];
      await expect(service.transitionAlongPath('PROJ-123', path, 'Fixed')).rejects.toThrow('Invalid transition');
    });
  });

  describe('createTicket with additionalFields', () => {
    it('passes additionalFields to createIssue', async () => {
      await service.createTicket('PROJ', 'Login bug', 'Bug', { priority: 'High' });
      expect(client.createIssueCalls[0].additionalFields).toEqual({ priority: 'High' });
    });

    it('works without additionalFields', async () => {
      await service.createTicket('PROJ', 'Login bug', 'Bug');
      expect(client.createIssueCalls[0].additionalFields).toBeUndefined();
    });
  });
});

describe('TicketService filter methods', () => {
  let client: MockJiraClient;
  let service: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    service = new TicketService(client);
  });

  describe('getFilterById', () => {
    it('returns the filter name and jql for a known id', async () => {
      const filter = await service.getFilterById('12345');
      expect(filter.id).toBe('12345');
      expect(filter.name).toBe('My open bugs');
      expect(filter.jql).toContain('assignee');
    });

    it('propagates errors for unknown filter ids', async () => {
      await expect(service.getFilterById('99999')).rejects.toThrow();
    });
  });

  describe('searchFiltersByName', () => {
    it('returns matching filters for a known name fragment', async () => {
      const filters = await service.searchFiltersByName('open bugs');
      expect(filters.length).toBeGreaterThan(0);
      expect(filters[0].name).toMatch(/open bugs/i);
      expect(filters[0].jql).toBeTruthy();
    });

    it('returns empty array when no filters match', async () => {
      const filters = await service.searchFiltersByName('nonexistent-xyzzy');
      expect(filters).toEqual([]);
    });
  });
});

describe('TicketService field resolution', () => {
  let client: MockJiraClient;
  let service: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    service = new TicketService(client);
  });

  describe('resolveFieldId', () => {
    it('returns the field id for an exact name match', async () => {
      expect(await service.resolveFieldId('Team Names')).toBe('customfield_10500');
    });

    it('matches field names case-insensitively', async () => {
      expect(await service.resolveFieldId('team names')).toBe('customfield_10500');
    });

    it('resolves SUPPORTED_FIELDS aliases without hitting the API', async () => {
      expect(await service.resolveFieldId('fixVersion')).toBe('fixVersions');
      expect(await service.resolveFieldId('fixVersions')).toBe('fixVersions');
      expect(await service.resolveFieldId('fix version')).toBe('fixVersions');
    });

    it('matches by field ID when the display name does not match', async () => {
      // "customfield_10500" is the ID of "Team Names" in the mock
      expect(await service.resolveFieldId('customfield_10500')).toBe('customfield_10500');
    });

    it('throws a clear error for unknown field names', async () => {
      await expect(service.resolveFieldId('nonexistent field xyz')).rejects.toThrow(/nonexistent field xyz/);
    });
  });

  describe('buildFieldValue', () => {
    it('returns a plain string for schema type "string"', async () => {
      const val = await service.buildFieldValue('summary', 'PROJ-123', 'New title');
      expect(val).toBe('New title');
    });

    it('returns array-of-name-objects for array fields whose allowedValues have a name key', async () => {
      const val = await service.buildFieldValue('customfield_10500', 'PROJ-123', 'ASL Cary');
      expect(val).toEqual([{ name: 'ASL Cary' }]);
    });

    it('returns array-of-value-objects for array fields whose allowedValues have a value key', async () => {
      const val = await service.buildFieldValue('customfield_10501', 'PROJ-123', 'Option A');
      expect(val).toEqual([{ value: 'Option A' }]);
    });

    it('returns a value-object for option fields', async () => {
      const val = await service.buildFieldValue('priority', 'PROJ-123', 'High');
      expect(val).toEqual({ name: 'High' });
    });

    it('throws a clear error when the field is not present in editmeta', async () => {
      await expect(service.buildFieldValue('customfield_99999', 'PROJ-123', 'x')).rejects.toThrow(/customfield_99999/);
    });
  });
});

describe('resolveFieldIdFuzzy', () => {
  const fields: JiraFieldMeta[] = [
    { id: 'summary', name: 'Summary', navigable: true, schema: { type: 'string' } },
    { id: 'customfield_10020', name: 'Sprint', navigable: true, schema: { type: 'array', items: 'json', custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
    { id: 'customfield_10500', name: 'Team Names', navigable: true, schema: { type: 'array', items: 'json' } },
    { id: 'customfield_10501', name: 'Team Region', navigable: true, schema: { type: 'string' } },
  ];

  it('returns match on exact name (case-insensitive)', () => {
    const result = resolveFieldIdFuzzy('summary', fields);
    expect(result.kind).toBe('match');
    if (result.kind === 'match') expect(result.field.id).toBe('summary');
  });

  it('returns match on exact field ID', () => {
    const result = resolveFieldIdFuzzy('customfield_10020', fields);
    expect(result.kind).toBe('match');
    if (result.kind === 'match') expect(result.field.name).toBe('Sprint');
  });

  it('returns match on unique prefix', () => {
    const result = resolveFieldIdFuzzy('sum', fields);
    expect(result.kind).toBe('match');
    if (result.kind === 'match') expect(result.field.id).toBe('summary');
  });

  it('returns candidates when multiple fields share a prefix', () => {
    const result = resolveFieldIdFuzzy('team', fields);
    expect(result.kind).toBe('candidates');
    if (result.kind === 'candidates') expect(result.fields).toHaveLength(2);
  });

  it('returns match on unique substring', () => {
    const result = resolveFieldIdFuzzy('region', fields);
    expect(result.kind).toBe('match');
    if (result.kind === 'match') expect(result.field.id).toBe('customfield_10501');
  });

  it('returns none when nothing matches', () => {
    const result = resolveFieldIdFuzzy('doesnotexist', fields);
    expect(result.kind).toBe('none');
  });
});

describe('formatIssueFields', () => {
  const fields: JiraFieldMeta[] = [
    { id: 'summary', name: 'Summary', navigable: true, schema: { type: 'string' } },
    { id: 'status', name: 'Status', navigable: true, schema: { type: 'status' } },
    { id: 'assignee', name: 'Assignee', navigable: true, schema: { type: 'user' } },
    { id: 'description', name: 'Description', navigable: true, schema: { type: 'string' } },
    { id: 'comment', name: 'Comment', navigable: false, schema: { type: 'comments-page' } },
    { id: 'subtasks', name: 'Sub-Tasks', navigable: false, schema: { type: 'array', items: 'issuelinks' } },
    { id: 'customfield_10020', name: 'Sprint', navigable: true, schema: { type: 'array', items: 'json', custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
  ];

  it('renders status and assignee in the table', () => {
    const issue = {
      id: '1', key: 'PROJ-1',
      fields: {
        summary: 'Test', description: null,
        status: { name: 'In Progress' },
        assignee: { displayName: 'Jane Doe', accountId: 'abc' },
        reporter: null, priority: null, labels: [], fixVersions: [], comment: null,
      },
    };
    const { table } = formatIssueFields(issue as never, fields, new Set());
    expect(table).toContain('Status');
    expect(table).toContain('In Progress');
    expect(table).toContain('Assignee');
    expect(table).toContain('Jane Doe');
  });

  it('excludes comment and subtasks fields', () => {
    const issue = {
      id: '1', key: 'PROJ-1',
      fields: {
        summary: 'Test', description: null,
        status: { name: 'Open' }, assignee: null, reporter: null,
        priority: null, labels: [], fixVersions: [],
        comment: { comments: [], total: 0 },
        subtasks: [],
      },
    };
    const { table, sections } = formatIssueFields(issue as never, fields, new Set());
    expect(table).not.toContain('Comment');
    expect(table + sections.join('')).not.toContain('Sub-Tasks');
  });

  it('excludes non-navigable fields', () => {
    const issue = {
      id: '1', key: 'PROJ-1',
      fields: {
        summary: 'Test', description: null,
        status: { name: 'Open' }, assignee: null, reporter: null,
        priority: null, labels: [], fixVersions: [], comment: null,
      },
    };
    const { table } = formatIssueFields(issue as never, fields, new Set());
    // comment has navigable: false — should not appear in table
    expect(table).not.toContain('Comment');
  });

  it('renders long description as a section not a table row', () => {
    const longDesc = 'x'.repeat(200);
    const issue = {
      id: '1', key: 'PROJ-1',
      fields: {
        summary: 'Test', description: longDesc,
        status: { name: 'Open' }, assignee: null, reporter: null,
        priority: null, labels: [], fixVersions: [], comment: null,
      },
    };
    const { table, sections } = formatIssueFields(issue as never, fields, new Set());
    expect(table).not.toContain(longDesc);
    expect(sections.some(s => s.includes('## Description'))).toBe(true);
  });

  it('renders active sprint name in table row', () => {
    const issue = {
      id: '1', key: 'PROJ-1',
      fields: {
        summary: 'Test', description: null,
        status: { name: 'Open' }, assignee: null, reporter: null,
        priority: null, labels: [], fixVersions: [], comment: null,
        customfield_10020: [{ name: 'Sprint 42', state: 'active' }, { name: 'Sprint 41', state: 'closed' }],
      },
    };
    const { table } = formatIssueFields(issue as never, fields, new Set());
    expect(table).toContain('Sprint 42');
  });

  it('renders sprint name from Jira DC serialized string format', () => {
    const issue = {
      id: '1', key: 'PROJ-1',
      fields: {
        summary: 'Test', description: null,
        status: { name: 'Open' }, assignee: null, reporter: null,
        priority: null, labels: [], fixVersions: [], comment: null,
        customfield_10020: [
          'com.atlassian.greenhopper.service.sprint.Sprint@abc[id=42,rapidViewId=72,state=ACTIVE,name=Sprint Everest,startDate=2024-01-01T00:00:00.000Z,endDate=<null>,completeDate=<null>,sequence=42,goal=<null>]',
        ],
      },
    };
    const { table } = formatIssueFields(issue as never, fields, new Set());
    expect(table).toContain('Sprint Everest');
    expect(table).not.toContain('undefined');
  });

  it('shows alwaysShowIds fields even when null', () => {
    const issue = {
      id: '1', key: 'PROJ-1',
      fields: {
        summary: 'Test', description: null,
        status: { name: 'Open' }, assignee: null, reporter: null,
        priority: null, labels: [], fixVersions: [], comment: null,
        customfield_10020: null,
      },
    };
    const { table } = formatIssueFields(issue as never, fields, new Set(['customfield_10020']));
    expect(table).toContain('Sprint');
    expect(table).toContain('_Not set_');
  });
});

describe('TicketService buildArrayValue', () => {
  let client: MockJiraClient;
  let service: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    service = new TicketService(client);
  });

  it('set replaces the entire array', async () => {
    const result = await service.buildArrayValue('customfield_10500', 'PROJ-123', ['Alpha', 'Beta'], 'set', []);
    expect(result).toEqual([{ name: 'Alpha' }, { name: 'Beta' }]);
  });

  it('add merges new items without duplicates', async () => {
    const current = [{ name: 'Alpha' }];
    const result = await service.buildArrayValue('customfield_10500', 'PROJ-123', ['Beta', 'Alpha'], 'add', current);
    expect(result).toEqual([{ name: 'Alpha' }, { name: 'Beta' }]);
  });

  it('remove filters out matching items case-insensitively', async () => {
    const current = [{ name: 'Alpha' }, { name: 'Beta' }, { name: 'Gamma' }];
    const result = await service.buildArrayValue('customfield_10500', 'PROJ-123', ['beta'], 'remove', current);
    expect(result).toEqual([{ name: 'Alpha' }, { name: 'Gamma' }]);
  });

  it('uses value key for option fields (allowedValues has value key)', async () => {
    const result = await service.buildArrayValue('customfield_10501', 'PROJ-123', ['Option A'], 'set', []);
    expect(result).toEqual([{ value: 'Option A' }]);
  });
});

describe('TicketService.bulkUpdateField', () => {
  let client: MockJiraClient;
  let service: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    service = new TicketService(client);
  });

  it('calls updateIssue with the correct field payload for each key', async () => {
    await service.bulkUpdateField(['PROJ-1', 'PROJ-2'], 'customfield_10020', 42, () => {});
    expect(client.updateIssueCalls).toHaveLength(2);
    expect(client.updateIssueCalls[0].fields).toEqual({ customfield_10020: 42 });
    expect(client.updateIssueCalls[1].fields).toEqual({ customfield_10020: 42 });
  });

  it('reports failures without stopping the batch', async () => {
    client.updateIssue = async (key) => {
      if (key === 'PROJ-2') throw new Error('Forbidden');
    };
    const results: Array<{ key: string; ok: boolean; err?: string }> = [];
    await service.bulkUpdateField(['PROJ-1', 'PROJ-2', 'PROJ-3'], 'priority', { name: 'High' },
      (key, ok, err) => results.push({ key, ok, err }));
    expect(results.find(r => r.key === 'PROJ-1')?.ok).toBe(true);
    expect(results.find(r => r.key === 'PROJ-2')?.ok).toBe(false);
    expect(results.find(r => r.key === 'PROJ-3')?.ok).toBe(true);
  });
});

describe('TicketService findSprints', () => {
  let client: MockJiraClient;
  let service: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    service = new TicketService(client);
  });

  it('returns only active and future sprints', async () => {
    const results = await service.findSprints('PROJ', 'Sprint');
    expect(results.every(s => s.state === 'active' || s.state === 'future')).toBe(true);
    expect(results.some(s => s.state === 'closed')).toBe(false);
  });

  it('filters by case-insensitive substring match', async () => {
    const results = await service.findSprints('PROJ', 'sprint 42');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Sprint 42');
  });

  it('returns empty array when query does not match any sprint', async () => {
    const results = await service.findSprints('PROJ', 'nonexistent-xyz');
    expect(results).toHaveLength(0);
  });
});

describe('TicketService showFields', () => {
  let client: MockJiraClient;
  let service: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    service = new TicketService(client);
  });

  it('returns a table with Field name, Field ID, and Current value columns', async () => {
    const result = await service.showFields('PROJ-123');
    expect(result).toContain('Field name');
    expect(result).toContain('Field ID');
    expect(result).toContain('Current value');
  });

  it('shows the ticket key in the heading', async () => {
    const result = await service.showFields('PROJ-123');
    expect(result).toContain('PROJ-123');
  });

  it('includes field IDs in backtick code spans', async () => {
    const result = await service.showFields('PROJ-123');
    expect(result).toMatch(/`summary`/);
  });

  it('resolves ticket from branch when no key given in prompt — showFields requires explicit key', async () => {
    // showFields always receives a resolved key from the participant layer
    const result = await service.showFields('PROJ-123');
    expect(result).toBeTruthy();
  });
});

describe('extractTextFromAdf', () => {
  it('returns plain string as-is (API v2)', () => {
    expect(extractTextFromAdf('Hello from v2')).toBe('Hello from v2');
  });

  it('extracts text from an ADF document (API v3)', () => {
    const adf = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] };
    expect(extractTextFromAdf(adf)).toBe('Hello');
  });

  it('returns empty string for null', () => {
    expect(extractTextFromAdf(null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Attachment methods
// ---------------------------------------------------------------------------

const attachmentMeta: JiraFieldMeta[] = [
  { id: 'attachment', name: 'Attachment', navigable: true, schema: { type: 'array', items: 'attachment' } },
  { id: 'summary', name: 'Summary', navigable: true, schema: { type: 'string' } },
];

const sampleAttachments: JiraAttachment[] = [
  { id: 'a1', filename: 'screenshot.png', mimeType: 'image/png', size: 239616, content: 'https://jira.example.com/att1' },
  { id: 'a2', filename: 'error.log', mimeType: 'text/plain', size: 46080, content: 'https://jira.example.com/att2' },
  { id: 'a3', filename: 'heap-dump.bin', mimeType: 'application/octet-stream', size: 52428800, content: 'https://jira.example.com/att3' },
];

function makeIssueWithAttachments(attachments: JiraAttachment[]): JiraIssue {
  return {
    id: '1', key: 'PROJ-1',
    fields: {
      summary: 'Test', description: null, status: { name: 'Open' },
      assignee: null, reporter: null, priority: null,
      labels: [], fixVersions: [], comment: null, attachment: attachments,
    },
  };
}

describe('TicketService.getAttachments', () => {
  let client: MockJiraClient;
  let service: TicketService;
  beforeEach(() => { client = new MockJiraClient(); service = new TicketService(client); });

  it('returns attachment list from issue', async () => {
    const issue = await client.getIssue('PROJ-123');
    const result = service.getAttachments(issue);
    expect(result.length).toBe(3);
    expect(result[0].filename).toBe('screenshot.png');
    expect(result[0].content).toContain('att001');
  });

  it('returns empty array when attachment field is undefined', () => {
    const issue = makeIssueWithAttachments([]);
    issue.fields.attachment = undefined;
    expect(service.getAttachments(issue)).toEqual([]);
  });

  it('returns empty array when attachment array is empty', () => {
    expect(service.getAttachments(makeIssueWithAttachments([]))).toEqual([]);
  });
});

describe('TicketService.downloadAttachment', () => {
  let client: MockJiraClient;
  let service: TicketService;
  beforeEach(() => { client = new MockJiraClient(); service = new TicketService(client); });

  it('delegates to client and returns bytes', async () => {
    const bytes = await service.downloadAttachment('https://jira.example.com/att1');
    expect(bytes).toEqual(FIXTURE_ATTACHMENT_BYTES);
  });

  it('propagates errors from the client', async () => {
    client.downloadAttachment = async () => { throw new Error('Network error'); };
    await expect(service.downloadAttachment('https://jira.example.com/att1')).rejects.toThrow('Network error');
  });
});

describe('TicketService.getAllComments', () => {
  let client: MockJiraClient;
  let service: TicketService;
  beforeEach(() => { client = new MockJiraClient(); service = new TicketService(client); });

  it('returns all comments from the fixture', async () => {
    const comments = await service.getAllComments('PROJ-123');
    expect(comments.length).toBeGreaterThan(0);
    expect(comments[0].author.displayName).toBeTruthy();
  });

  it('returns empty array for a ticket with no comments', async () => {
    client.getIssue = async () => makeIssueWithAttachments([]);
    const comments = await service.getAllComments('PROJ-123');
    expect(comments).toEqual([]);
  });
});

describe('formatIssueFields — attachment section', () => {
  it('renders attachment list with size and MIME type', () => {
    const issue = makeIssueWithAttachments(sampleAttachments);
    const { sections } = formatIssueFields(issue, attachmentMeta, new Set());
    const attSection = sections.find(s => s.startsWith('## Attachments'));
    expect(attSection).toBeDefined();
    expect(attSection).toContain('screenshot.png');
    expect(attSection).toContain('234 KB');
    expect(attSection).toContain('image/png');
    expect(attSection).toContain('error.log');
    expect(attSection).toContain('45 KB');
    expect(attSection).toContain('50.0 MB');
  });

  it('suppresses attachment section when attachment id is in hiddenIds', () => {
    const issue = makeIssueWithAttachments(sampleAttachments);
    const { sections } = formatIssueFields(issue, attachmentMeta, new Set(), new Set(['attachment']));
    expect(sections.find(s => s.startsWith('## Attachments'))).toBeUndefined();
  });

  it('does not render attachment section when field is empty', () => {
    const issue = makeIssueWithAttachments([]);
    const { sections } = formatIssueFields(issue, attachmentMeta, new Set());
    expect(sections.find(s => s.startsWith('## Attachments'))).toBeUndefined();
  });
});

describe('renderFieldValue', () => {
  const sprintMeta: JiraFieldMeta = {
    id: 'customfield_10020', name: 'Sprint', navigable: true,
    schema: { type: 'array', items: 'json', custom: 'com.pyxis.greenhopper.jira:gh-sprint' },
  };

  it('renders active sprint name from object format', () => {
    const value = [{ name: 'Sprint 42', state: 'active' }, { name: 'Sprint 41', state: 'closed' }];
    expect(renderFieldValue(value, sprintMeta)).toBe('Sprint 42');
  });

  it('renders sprint name from Jira DC serialized string format', () => {
    const value = ['com.atlassian.greenhopper.service.sprint.Sprint@abc[id=42,rapidViewId=72,state=ACTIVE,name=Sprint Everest,startDate=2024-01-01T00:00:00.000Z]'];
    expect(renderFieldValue(value, sprintMeta)).toBe('Sprint Everest');
    expect(renderFieldValue(value, sprintMeta)).not.toContain('undefined');
  });

  it('returns _None_ for empty sprint array', () => {
    expect(renderFieldValue([], sprintMeta)).toBe('_None_');
  });

  it('renders plain string fields correctly', () => {
    const textMeta: JiraFieldMeta = { id: 'summary', name: 'Summary', navigable: true, schema: { type: 'string' } };
    expect(renderFieldValue('Hello world', textMeta)).toBe('Hello world');
  });
});
