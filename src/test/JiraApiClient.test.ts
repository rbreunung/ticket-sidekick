import { describe, it, expect, vi, afterEach } from 'vitest';
import { JiraApiClient } from '../jira/JiraApiClient';

const BASE_CONFIG = {
  baseUrl: 'https://jira.example.com',
  authType: 'datacenter' as const,
  token: 'my-pat-token',
};

function makeFetch(body: unknown, status = 200, contentType = 'application/json'): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'OK',
    headers: { get: (h: string) => h === 'content-type' ? contentType : null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

describe('JiraApiClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('auth headers', () => {
    it('sends Bearer header for datacenter auth', async () => {
      const mockFetch = makeFetch({ id: '1', key: 'PROJ-123', fields: {} });
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient(BASE_CONFIG);
      await client.getIssue('PROJ-123');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://jira.example.com/rest/api/2/issue/PROJ-123',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer my-pat-token' }),
        }),
      );
    });

    it('sends Basic header for cloud auth', async () => {
      const mockFetch = makeFetch({ id: '1', key: 'PROJ-123', fields: {} });
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient({ ...BASE_CONFIG, authType: 'cloud' });
      await client.getIssue('PROJ-123');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Basic my-pat-token' }),
        }),
      );
    });
  });

  describe('error handling', () => {
    it('throws auth error on 401 and includes the URL', async () => {
      vi.stubGlobal('fetch', makeFetch({}, 401));
      const client = new JiraApiClient(BASE_CONFIG);
      await expect(client.getIssue('PROJ-123')).rejects.toThrow('https://jira.example.com/rest/api/2/issue/PROJ-123');
    });

    it('throws not found error on 404 and includes the URL', async () => {
      vi.stubGlobal('fetch', makeFetch({}, 404));
      const client = new JiraApiClient(BASE_CONFIG);
      await expect(client.getIssue('PROJ-999')).rejects.toThrow('https://jira.example.com/rest/api/2/issue/PROJ-999');
    });
  });

  describe('URL construction', () => {
    it('removes trailing slash from baseUrl', async () => {
      const mockFetch = makeFetch({ id: '1', key: 'PROJ-1', fields: {} });
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient({ ...BASE_CONFIG, baseUrl: 'https://jira.example.com/' });
      await client.getIssue('PROJ-1');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://jira.example.com/rest/api/2/issue/PROJ-1',
        expect.anything(),
      );
    });

    it('always uses /rest/api/2', async () => {
      const mockFetch = makeFetch({ id: '1', key: 'PROJ-1', fields: {} });
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient(BASE_CONFIG);
      await client.getIssue('PROJ-1');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://jira.example.com/rest/api/2/issue/PROJ-1',
        expect.anything(),
      );
    });

    it('createIssue posts to /rest/api/2/issue', async () => {
      const mockFetch = makeFetch({ id: '10001', key: 'PROJ-1' }, 201);
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient(BASE_CONFIG);
      await client.createIssue('PROJ', 'My ticket', 'Bug');
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://jira.example.com/rest/api/2/issue');
      expect(options.method).toBe('POST');
    });
  });

  describe('addComment', () => {
    it('posts comment body as plain string', async () => {
      const mockFetch = makeFetch({}, 201);
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient(BASE_CONFIG);
      await client.addComment('PROJ-123', 'Looks good!');
      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.body).toBe('Looks good!');
    });
  });

  describe('searchJql', () => {
    it('sends JQL as a GET query param to /search/jql', async () => {
      const mockFetch = makeFetch({ issues: [], isLast: true });
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient(BASE_CONFIG);
      const result = await client.searchJql('project = PROJ');
      expect(result.issues).toHaveLength(0);
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/search?');
      expect(url).toContain('jql=project%20%3D%20PROJ');
      expect(options.method).toBeUndefined(); // GET has no explicit method
    });

    it('appends startAt to the query string when provided', async () => {
      const mockFetch = makeFetch({ issues: [], isLast: true });
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient(BASE_CONFIG);
      await client.searchJql('project = PROJ', 20, 40);
      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('startAt=40');
    });

    it('omits startAt from the query string when not provided', async () => {
      const mockFetch = makeFetch({ issues: [], isLast: true });
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient(BASE_CONFIG);
      await client.searchJql('project = PROJ');
      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).not.toContain('startAt');
    });
  });

  describe('getProjectStatuses', () => {
    const statusPayload = [
      { name: 'Bug', subtask: false, statuses: [{ id: '1', name: 'Open' }, { id: '2', name: 'Closed' }] },
      { name: 'Story', subtask: false, statuses: [{ id: '3', name: 'Backlog' }] },
    ];

    it('calls the correct endpoint and returns status names for the issue type', async () => {
      const mockFetch = makeFetch(statusPayload);
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient(BASE_CONFIG);
      const result = await client.getProjectStatuses('PROJ', 'Bug');
      expect(result).toEqual(['Open', 'Closed']);
      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://jira.example.com/rest/api/2/project/PROJ/statuses');
    });

    it('matches issue type case-insensitively', async () => {
      const mockFetch = makeFetch(statusPayload);
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient(BASE_CONFIG);
      const result = await client.getProjectStatuses('PROJ', 'bug');
      expect(result).toEqual(['Open', 'Closed']);
    });

    it('returns empty array when issue type is not found', async () => {
      const mockFetch = makeFetch(statusPayload);
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient(BASE_CONFIG);
      const result = await client.getProjectStatuses('PROJ', 'Epic');
      expect(result).toEqual([]);
    });
  });

  describe('HTML response detection', () => {
    const htmlBody = '<!DOCTYPE html><html><body><h1>Sign in</h1></body></html>';

    it('throws a helpful error when main API returns HTML (wrong sub-path / proxy redirect)', async () => {
      vi.stubGlobal('fetch', makeFetch(htmlBody, 200, 'text/html; charset=utf-8'));
      const client = new JiraApiClient(BASE_CONFIG);
      await expect(client.getIssue('PROJ-1')).rejects.toThrow('HTML instead of JSON');
    });

    it('error message hints at baseUrl misconfiguration', async () => {
      vi.stubGlobal('fetch', makeFetch(htmlBody, 200, 'text/html; charset=utf-8'));
      const client = new JiraApiClient(BASE_CONFIG);
      await expect(client.getIssue('PROJ-1')).rejects.toThrow('ticketSidekick.jira.baseUrl');
    });

    it('error message includes a preview of the HTML response', async () => {
      vi.stubGlobal('fetch', makeFetch(htmlBody, 200, 'text/html; charset=utf-8'));
      const client = new JiraApiClient(BASE_CONFIG);
      await expect(client.getIssue('PROJ-1')).rejects.toThrow('Sign in');
    });

    it('throws helpful error when agile API returns HTML', async () => {
      vi.stubGlobal('fetch', makeFetch(htmlBody, 200, 'text/html'));
      const client = new JiraApiClient(BASE_CONFIG);
      await expect(client.getSprintByName('PROJ', 'Sprint 1')).rejects.toThrow('HTML instead of JSON');
    });
  });
});
