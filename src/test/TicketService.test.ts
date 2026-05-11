import { describe, it, expect, beforeEach } from 'vitest';
import { TicketService, assembleDescription } from '../services/TicketService';
import { MockJiraClient } from './mocks/MockJiraClient';

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

    it('propagates not-found error for unknown ticket', async () => {
      await expect(service.getTicket('PROJ-404')).rejects.toThrow('Not found');
    });

    it('includes comments section when ticket has comments', async () => {
      const result = await service.getTicket('PROJ-123');
      expect(result).toContain('Comments');
      expect(result).toContain('John Smith');
      expect(result).toContain('Please add unit tests for the token refresh flow.');
    });

    it('shows comment date', async () => {
      const result = await service.getTicket('PROJ-123');
      expect(result).toContain('2024-02-01');
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

    it('updates description wrapped in ADF', async () => {
      await service.updateField('PROJ-123', 'description', 'New desc');
      const fields = client.updateIssueCalls[0]?.fields;
      expect((fields?.description as { type: string }).type).toBe('doc');
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
      expect(result).toContain('ticketSidekick.requiredFields');
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
