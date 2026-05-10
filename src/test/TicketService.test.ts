import { describe, it, expect, beforeEach } from 'vitest';
import { TicketService } from '../services/TicketService';
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
});
