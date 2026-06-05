import { describe, it, expect, vi, afterEach } from 'vitest';
import { JiraApiClient, buildFileContentDisposition, JiraApiError } from '../jira/JiraApiClient';

describe('JiraApiError typing (#9)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('throws a JiraApiError carrying the numeric status for a 403', async () => {
    vi.stubGlobal('fetch', makeFetch({}, 403));
    const client = new JiraApiClient(BASE_CONFIG);
    await expect(client.getIssue('PROJ-1')).rejects.toBeInstanceOf(JiraApiError);
    await client.getIssue('PROJ-1').catch((err: unknown) => {
      expect(err).toBeInstanceOf(JiraApiError);
      expect((err as JiraApiError).status).toBe(403);
    });
  });

  it('sets status 401 on auth failures and 404 on not-found', async () => {
    vi.stubGlobal('fetch', makeFetch({}, 401));
    const client = new JiraApiClient(BASE_CONFIG);
    const authErr = await client.getIssue('PROJ-1').catch((e: unknown) => e);
    expect((authErr as JiraApiError).status).toBe(401);

    vi.stubGlobal('fetch', makeFetch({}, 404));
    const nfErr = await client.getIssue('PROJ-9').catch((e: unknown) => e);
    expect((nfErr as JiraApiError).status).toBe(404);
  });
});

describe('buildFileContentDisposition (attachment filename safety)', () => {
  it('keeps a plain ASCII filename and adds an RFC 5987 filename*', () => {
    const d = buildFileContentDisposition('report.pdf');
    expect(d).toContain('filename="report.pdf"');
    expect(d).toContain("filename*=UTF-8''report.pdf");
  });

  it('neutralizes a quote in the filename so the header cannot be broken', () => {
    const d = buildFileContentDisposition('evil".pdf');
    // The quoted fallback must not contain a raw double-quote beyond its own delimiters.
    const fallback = d.match(/filename="([^]*?)"/)![1];
    expect(fallback).not.toContain('"');
  });

  it('strips CR/LF so no extra headers can be injected', () => {
    const d = buildFileContentDisposition('a\r\nContent-Type: text/html\r\n\r\n.png');
    expect(d).not.toContain('\r');
    expect(d).not.toContain('\n');
  });

  it('round-trips a Unicode filename via filename* (UTF-8 percent-encoded)', () => {
    const d = buildFileContentDisposition('Übung.pdf');
    expect(d).toContain("filename*=UTF-8''%C3%9Cbung.pdf");
    // ASCII fallback degrades the non-ASCII char but stays valid.
    expect(d).toMatch(/filename="[\x20-\x7e]*"/);
  });
});

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

  describe('request headers', () => {
    it('GET requests do not include Content-Type', async () => {
      const mockFetch = makeFetch({ id: '1', key: 'PROJ-123', fields: {} });
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient(BASE_CONFIG);
      await client.getIssue('PROJ-123');
      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((options.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    });

    it('POST requests include Content-Type: application/json', async () => {
      const mockFetch = makeFetch({ id: '10001', key: 'PROJ-1' }, 201);
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient(BASE_CONFIG);
      await client.addComment('PROJ-1', 'hello');
      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((options.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    });
  });

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
    it('uses /rest/api/2/search for datacenter', async () => {
      const mockFetch = makeFetch({ issues: [], isLast: true });
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient(BASE_CONFIG);
      const result = await client.searchJql('project = PROJ');
      expect(result.issues).toHaveLength(0);
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/rest/api/2/search?');
      expect(url).toContain('jql=project%20%3D%20PROJ');
      expect(options.method).toBeUndefined();
    });

    it('uses /rest/api/3/search/jql for cloud', async () => {
      const mockFetch = makeFetch({ issues: [], isLast: true });
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient({ ...BASE_CONFIG, authType: 'cloud' });
      const result = await client.searchJql('project = PROJ');
      expect(result.issues).toHaveLength(0);
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/rest/api/3/search/jql?');
      expect(url).toContain('jql=project%20%3D%20PROJ');
      expect(options.method).toBeUndefined();
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

  describe('getAllComments', () => {
    const comment = (id: string) => ({ id, author: { displayName: 'A' }, body: 'x', created: '2026-01-01' });

    function makePagedFetch(pages: Array<{ comments: unknown[]; total: number }>): ReturnType<typeof vi.fn> {
      let call = 0;
      return vi.fn().mockImplementation(() => {
        const page = pages[Math.min(call, pages.length - 1)];
        call++;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: (h: string) => (h === 'content-type' ? 'application/json' : null) },
          json: () => Promise.resolve(page),
        });
      });
    }

    it('paginates across full pages until total is reached', async () => {
      const mockFetch = makePagedFetch([
        { comments: [comment('1'), comment('2')], total: 3 },
        { comments: [comment('3')], total: 3 },
      ]);
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient(BASE_CONFIG);
      const result = await client.getAllComments('PROJ-1');
      expect(result).toHaveLength(3);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('stops when a page returns no comments even if total is larger (no infinite loop)', async () => {
      const mockFetch = makePagedFetch([
        { comments: [comment('1'), comment('2')], total: 5 },
        { comments: [], total: 5 }, // empty page while total still says 5
      ]);
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient(BASE_CONFIG);
      const result = await client.getAllComments('PROJ-1');
      expect(result).toHaveLength(2);
      // Without the guard this would loop forever; assert it stayed bounded.
      expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(3);
    });
  });

  describe('getRemoteLinks error handling', () => {
    it('returns [] when the remotelink endpoint 404s (feature absent / none)', async () => {
      vi.stubGlobal('fetch', makeFetch({}, 404));
      const client = new JiraApiClient(BASE_CONFIG);
      await expect(client.getRemoteLinks('PROJ-1')).resolves.toEqual([]);
    });

    it('rethrows an auth failure instead of masking it as empty links', async () => {
      vi.stubGlobal('fetch', makeFetch({}, 401));
      const client = new JiraApiClient(BASE_CONFIG);
      await expect(client.getRemoteLinks('PROJ-1')).rejects.toThrow(/Authentication failed/);
    });
  });

  describe('sprint lookup auth handling', () => {
    it('rethrows an auth failure during sprint fetch instead of silently skipping the board', async () => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
        if (url.includes('/board?')) {
          return Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ values: [{ id: 10, type: 'scrum' }] }) });
        }
        // sprint fetch returns 401
        return Promise.resolve({ ok: false, status: 401, statusText: 'Unauthorized', headers: { get: () => 'application/json' }, text: () => Promise.resolve('') });
      }));
      const client = new JiraApiClient(BASE_CONFIG);
      await expect(client.findSprints('PROJ', 'Everest')).rejects.toThrow(/401/);
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

  describe('sprint board resolution', () => {
    const scrumBoard = { id: 10, type: 'scrum' };
    const kanbanBoard = { id: 99, type: 'kanban' };
    const sprint = { id: 42, name: 'Sprint Everest', state: 'active' };

    it('skips Kanban boards and queries only Scrum boards', async () => {
      const calls: string[] = [];
      vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
        calls.push(url);
        if (url.includes('/board?')) {
          return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ values: [kanbanBoard, scrumBoard] }) });
        }
        if (url.includes('/board/10/sprint')) {
          return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ values: [sprint] }) });
        }
        // board 99 (Kanban) should never be queried for sprints
        return Promise.resolve({ ok: false, status: 400, statusText: 'Bad Request', headers: { get: () => 'application/json' }, json: () => Promise.resolve({}) });
      }));
      const client = new JiraApiClient(BASE_CONFIG);
      const result = await client.findSprints('PROJ', 'Everest');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(42);
      expect(calls.some(u => u.includes('/board/99/'))).toBe(false);
    });

    it('does not crash when a board returns 400 — continues to next board', async () => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
        if (url.includes('/board?')) {
          return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ values: [{ id: 1, type: 'scrum' }, { id: 2, type: 'scrum' }] }) });
        }
        if (url.includes('/board/1/sprint')) {
          return Promise.resolve({ ok: false, status: 400, statusText: 'Bad Request', headers: { get: () => 'application/json' }, json: () => Promise.resolve({}) });
        }
        return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ values: [sprint] }) });
      }));
      const client = new JiraApiClient(BASE_CONFIG);
      const result = await client.findSprints('PROJ', 'Everest');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(42);
    });

    it('uses sprintBoardId directly and skips board discovery', async () => {
      const calls: string[] = [];
      vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
        calls.push(url);
        if (url.includes('/board/55/sprint')) {
          return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ values: [sprint] }) });
        }
        return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ values: [] }) });
      }));
      const client = new JiraApiClient({ ...BASE_CONFIG, sprintBoardId: 55 });
      const result = await client.findSprints('PROJ', 'Everest');
      expect(result).toHaveLength(1);
      expect(calls.some(u => u.includes('/board?'))).toBe(false);
    });
  });
});
