import { describe, it, expect, vi, afterEach } from 'vitest';
import { JiraApiClient } from '../jira/JiraApiClient';

const BASE_CONFIG = {
  baseUrl: 'https://jira.example.com',
  authType: 'datacenter' as const,
  token: 'my-pat-token',
};

function makeFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'OK',
    json: () => Promise.resolve(body),
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
        'https://jira.example.com/rest/api/3/issue/PROJ-123',
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
    it('throws auth error on 401', async () => {
      vi.stubGlobal('fetch', makeFetch({}, 401));
      const client = new JiraApiClient(BASE_CONFIG);
      await expect(client.getIssue('PROJ-123')).rejects.toThrow('Authentication failed');
    });

    it('throws not found error on 404', async () => {
      vi.stubGlobal('fetch', makeFetch({}, 404));
      const client = new JiraApiClient(BASE_CONFIG);
      await expect(client.getIssue('PROJ-999')).rejects.toThrow('Not found');
    });
  });

  describe('URL construction', () => {
    it('removes trailing slash from baseUrl', async () => {
      const mockFetch = makeFetch({ id: '1', key: 'PROJ-1', fields: {} });
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient({ ...BASE_CONFIG, baseUrl: 'https://jira.example.com/' });
      await client.getIssue('PROJ-1');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://jira.example.com/rest/api/3/issue/PROJ-1',
        expect.anything(),
      );
    });
  });

  describe('addComment', () => {
    it('posts comment body in ADF format', async () => {
      const mockFetch = makeFetch({}, 201);
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient(BASE_CONFIG);
      await client.addComment('PROJ-123', 'Looks good!');
      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.body.type).toBe('doc');
      expect(body.body.content[0].content[0].text).toBe('Looks good!');
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
      expect(url).toContain('/search/jql');
      expect(url).toContain('jql=project%20%3D%20PROJ');
      expect(options.method).toBeUndefined(); // GET has no explicit method
    });
  });
});
