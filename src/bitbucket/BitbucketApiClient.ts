import type { BitbucketAuthType, BitbucketCommentResult, BitbucketPR, BitbucketUser, IBitbucketClient, InlineAnchor } from './IBitbucketClient';
import { fetchWithRetry } from '../utils/fetchWithRetry';
import { BitbucketApiError } from '../utils/apiError';

export { BitbucketApiError } from '../utils/apiError';

// Bitbucket Data Center /pull-requests/{id}/diff response shape (API 1.0)
interface DcDiffLine { line: string; truncated?: boolean; }
interface DcDiffSegment { type: 'ADDED' | 'REMOVED' | 'CONTEXT'; lines: DcDiffLine[]; }
interface DcDiffHunk {
  sourceLine: number; sourceSpan: number;
  destinationLine: number; destinationSpan: number;
  segments: DcDiffSegment[];
}
interface DcFileDiff {
  source: { toString: string } | null;
  destination: { toString: string } | null;
  hunks?: DcDiffHunk[];
}
interface DcDiffResponse { diffs: DcFileDiff[]; }

export function dcDiffToUnified(response: DcDiffResponse): string {
  return response.diffs.map((fileDiff) => {
    const srcPath = fileDiff.source?.toString;
    const dstPath = fileDiff.destination?.toString;
    const aPath = srcPath ? `a/${srcPath}` : '/dev/null';
    const bPath = dstPath ? `b/${dstPath}` : '/dev/null';
    let out = `diff --git ${aPath} ${bPath}\n--- ${aPath}\n+++ ${bPath}\n`;
    for (const hunk of fileDiff.hunks ?? []) {
      out += `@@ -${hunk.sourceLine},${hunk.sourceSpan} +${hunk.destinationLine},${hunk.destinationSpan} @@\n`;
      for (const seg of hunk.segments) {
        const prefix = seg.type === 'ADDED' ? '+' : seg.type === 'REMOVED' ? '-' : ' ';
        for (const ln of seg.lines) { out += `${prefix}${ln.line}\n`; }
      }
    }
    return out;
  }).join('');
}

export interface BitbucketApiClientConfig {
  baseUrl: string;
  authType: BitbucketAuthType;
  token: string;
}

export class BitbucketApiClient implements IBitbucketClient {
  private readonly baseUrl: string;
  private readonly authType: BitbucketAuthType;
  private readonly authHeader: string;

  constructor(config: BitbucketApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.authType = config.authType;
    this.authHeader = config.authType === 'cloud'
      ? `Basic ${config.token}`
      : `Bearer ${config.token}`;
  }

  private async dcRequest<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}/rest/api/1.0${path}`;
    const response = await fetchWithRetry(url, {
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
    });
    if (!response.ok) {
      if (response.status === 401) throw new BitbucketApiError(`Authentication failed at ${url}. Check your Bitbucket credentials.`, 401, url);
      if (response.status === 404) throw new BitbucketApiError(`Not found: ${url}`, 404, url);
      const body = await response.text().catch(() => '');
      throw new BitbucketApiError(`Bitbucket API error ${response.status} at ${url}${body ? ` — ${body}` : ''}`, response.status, url, body);
    }
    const ct = response.headers.get('content-type') ?? '';
    if (ct.includes('text/html')) {
      const snippet = await response.text().then(t => t.slice(0, 120)).catch(() => '');
      throw new Error(
        `Bitbucket DC API returned HTML instead of JSON (HTTP ${response.status}). ` +
        `Check that 'ticketSidekick.bitbucket.baseUrl' points to the Bitbucket root. ` +
        `A proxy or redirect may also be intercepting the request.\n` +
        `Response preview: ${snippet}`,
      );
    }
    return response.json() as Promise<T>;
  }

  private async cloudRequest<T>(path: string): Promise<T> {
    const url = `https://api.bitbucket.org/2.0${path}`;
    const response = await fetchWithRetry(url, {
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status === 401) {
        const detail = body ? ` — ${body}` : '';
        throw new BitbucketApiError(`Authentication failed (401)${detail}. Run "Ticket Sidekick: Configure Bitbucket Cloud Credentials" and enter your Bitbucket username and an App Password (bitbucket.org → Personal settings → App passwords).`, 401, url, body);
      }
      if (response.status === 404) throw new BitbucketApiError(`Not found: ${url}`, 404, url);
      throw new BitbucketApiError(`Bitbucket Cloud API error ${response.status} at ${url}${body ? ` — ${body}` : ''}`, response.status, url, body);
    }
    return response.json() as Promise<T>;
  }

  private async dcPost<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}/rest/api/1.0${path}`;
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: { Authorization: this.authHeader, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      if (response.status === 401) throw new BitbucketApiError(`Authentication failed at ${url}. Check your Bitbucket credentials.`, 401, url);
      if (response.status === 404) throw new BitbucketApiError(`Not found: ${url}`, 404, url);
      const bodyText = await response.text().catch(() => '');
      throw new BitbucketApiError(`Bitbucket API error ${response.status} at ${url}${bodyText ? ` — ${bodyText}` : ''}`, response.status, url, bodyText);
    }
    return response.json() as Promise<T>;
  }

  private async cloudPost<T>(path: string, body: unknown): Promise<T> {
    const url = `https://api.bitbucket.org/2.0${path}`;
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: { Authorization: this.authHeader, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      if (response.status === 401) throw new BitbucketApiError(`Authentication failed (401)${bodyText ? ` — ${bodyText}` : ''}. Check your Bitbucket credentials.`, 401, url, bodyText);
      if (response.status === 404) throw new BitbucketApiError(`Not found: ${url}`, 404, url);
      throw new BitbucketApiError(`Bitbucket Cloud API error ${response.status} at ${url}${bodyText ? ` — ${bodyText}` : ''}`, response.status, url, bodyText);
    }
    return response.json() as Promise<T>;
  }

  private async cloudRequestText(path: string): Promise<string> {
    const url = `https://api.bitbucket.org/2.0${path}`;
    const response = await fetchWithRetry(url, {
      headers: { Authorization: this.authHeader, Accept: 'text/plain' },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status === 401) {
        throw new BitbucketApiError(`Authentication failed (401). Run "Ticket Sidekick: Configure Bitbucket Cloud Credentials" and enter your Bitbucket username and an App Password (bitbucket.org → Personal settings → App passwords).`, 401, url, body);
      }
      if (response.status === 404) throw new BitbucketApiError(`Not found: ${url}`, 404, url);
      throw new BitbucketApiError(`Bitbucket Cloud API error ${response.status} at ${url}${body ? ` — ${body}` : ''}`, response.status, url, body);
    }
    return response.text();
  }

  async getCurrentUser(): Promise<BitbucketUser> {
    if (this.authType === 'cloud') {
      try {
        const data = await this.cloudRequest<{ display_name: string }>('/user');
        return { displayName: data.display_name, emailAddress: '' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('403') || msg.includes('scope') || msg.includes('permission')) {
          return { displayName: '(add Account: Read scope to your App Password to show your username)', emailAddress: '' };
        }
        throw err;
      }
    }
    await this.dcRequest<unknown>('/profile/recent/repos?limit=1');
    return { displayName: 'Data Center user', emailAddress: '' };
  }

  async getPullRequest(project: string, repo: string, prId: number): Promise<BitbucketPR> {
    if (this.authType === 'cloud') {
      const data = await this.cloudRequest<{
        id: number;
        title: string;
        description: string;
        author: { display_name: string };
        destination: { branch: { name: string } };
        source: { commit: { hash: string } };
      }>(`/repositories/${project}/${repo}/pullrequests/${prId}`);
      return {
        id: data.id,
        title: data.title,
        description: data.description ?? '',
        author: { displayName: data.author.display_name, emailAddress: '' },
        targetBranch: data.destination.branch.name,
        fromCommitHash: data.source.commit.hash,
      };
    }
    const data = await this.dcRequest<{
      id: number;
      title: string;
      description: string;
      author: { user: { displayName: string; emailAddress: string } };
      toRef: { displayId: string };
      fromRef: { latestCommit: string };
    }>(`/projects/${project}/repos/${repo}/pull-requests/${prId}`);
    return {
      id: data.id,
      title: data.title,
      description: data.description ?? '',
      author: { displayName: data.author.user.displayName, emailAddress: data.author.user.emailAddress },
      targetBranch: data.toRef.displayId,
      fromCommitHash: data.fromRef.latestCommit,
    };
  }

  async getPullRequestDiff(project: string, repo: string, prId: number): Promise<string> {
    if (this.authType === 'cloud') {
      const raw = await this.cloudRequestText(`/repositories/${project}/${repo}/pullrequests/${prId}/diff`);
      // Bitbucket Cloud returns the diff as a JSON-encoded string (with surrounding quotes
      // and \n escape sequences instead of actual newlines). Decode it when that happens.
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string') return parsed;
      } catch {}
      return raw;
    }
    const data = await this.dcRequest<DcDiffResponse>(
      `/projects/${project}/repos/${repo}/pull-requests/${prId}/diff?withComments=false`,
    );
    return dcDiffToUnified(data);
  }

  async getFileContent(project: string, repo: string, path: string, commitHash: string): Promise<string> {
    // Encode each path segment (preserving '/' separators) and the commit hash so spaces,
    // '#', '?', and non-ASCII characters cannot break the request or corrupt the query.
    const encPath = path.split('/').map(encodeURIComponent).join('/');
    const encCommit = encodeURIComponent(commitHash);
    if (this.authType === 'cloud') {
      return this.cloudRequestText(`/repositories/${project}/${repo}/src/${encCommit}/${encPath}`);
    }
    // The browse API is paginated (default limit: 25 lines). Fetch with a high limit to
    // capture most source files in one request; very large files are truncated at 5000 lines.
    const data = await this.dcRequest<{ lines: Array<{ text: string }> }>(
      `/projects/${project}/repos/${repo}/browse/${encPath}?at=${encCommit}&limit=5000`,
    );
    return data.lines.map((l) => l.text).join('\n');
  }

  async addPrComment(
    project: string,
    repo: string,
    prId: number,
    text: string,
    inline?: InlineAnchor,
  ): Promise<BitbucketCommentResult> {
    if (this.authType === 'cloud') {
      const body: Record<string, unknown> = { content: { raw: text } };
      if (inline) {
        const side = inline.fileType === 'FROM' ? { from: inline.line } : { to: inline.line };
        body['inline'] = { path: inline.filePath, ...side };
      }
      const data = await this.cloudPost<{ id: number; links?: { html?: { href: string } } }>(
        `/repositories/${project}/${repo}/pullrequests/${prId}/comments`,
        body,
      );
      return { commentId: data.id, commentUrl: data.links?.html?.href };
    }
    const body: Record<string, unknown> = { text };
    if (inline) {
      body['anchor'] = { line: inline.line, lineType: inline.lineType, fileType: inline.fileType, path: inline.filePath };
    }
    const data = await this.dcPost<{ id: number }>(
      `/projects/${project}/repos/${repo}/pull-requests/${prId}/comments`,
      body,
    );
    return { commentId: data.id };
  }
}
