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
      expect(result).toContain('jiraCopilot.requiredFields');
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

  describe('getComments', () => {
    it('returns a summary list when comments exist', async () => {
      const result = await service.getComments('PROJ-123');
      expect(result).toContain('John Smith');
      expect(result).toContain('2024-02-01');
      expect(result).toContain('Please add unit tests');
    });

    it('includes comment count in the header', async () => {
      const result = await service.getComments('PROJ-123');
      expect(result).toMatch(/1 comment\(s\) on PROJ-123/);
    });

    it('returns no-comments message when ticket has no comments', async () => {
      client.getIssue = async () => {
        const base = await new MockJiraClient().getIssue('PROJ-123');
        return { ...base, fields: { ...base.fields, comment: { comments: [], total: 0 } } };
      };
      const result = await service.getComments('PROJ-123');
      expect(result).toBe('No comments on PROJ-123.');
    });

    it('truncates comments longer than 120 characters', async () => {
      const longText = 'x'.repeat(200);
      client.getIssue = async () => {
        const base = await new MockJiraClient().getIssue('PROJ-123');
        return {
          ...base,
          fields: {
            ...base.fields,
            comment: {
              comments: [{
                id: '99',
                author: { accountId: 'u1', displayName: 'Someone', emailAddress: 'a@b.com' },
                body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: longText }] }] },
                created: '2024-03-01T00:00:00.000Z',
              }],
              total: 1,
            },
          },
        };
      };
      const result = await service.getComments('PROJ-123');
      expect(result).toContain('…');
      expect(result).not.toContain('x'.repeat(200));
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
