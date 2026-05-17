import type { BitbucketAuthType, BitbucketPR, BitbucketUser, IBitbucketClient } from './IBitbucketClient';

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
    const response = await fetch(url, {
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error(`Authentication failed at ${url}. Check your Bitbucket credentials.`);
      if (response.status === 404) throw new Error(`Not found: ${url}`);
      const body = await response.text().catch(() => '');
      throw new Error(`Bitbucket API error ${response.status} at ${url}${body ? ` — ${body}` : ''}`);
    }
    return response.json() as Promise<T>;
  }

  private async dcRequestText(path: string): Promise<string> {
    const url = `${this.baseUrl}/rest/api/1.0${path}`;
    const response = await fetch(url, {
      headers: { Authorization: this.authHeader, Accept: 'text/plain' },
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error(`Authentication failed at ${url}. Check your Bitbucket credentials.`);
      throw new Error(`Bitbucket API error ${response.status} at ${url}`);
    }
    return response.text();
  }

  private async cloudRequest<T>(path: string): Promise<T> {
    const url = `https://api.bitbucket.org/2.0${path}`;
    const response = await fetch(url, {
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status === 401) {
        const detail = body ? ` — ${body}` : '';
        throw new Error(`Authentication failed (401)${detail}. Run "Ticket Sidekick: Configure Bitbucket Cloud Credentials" and enter your Bitbucket username and an App Password (bitbucket.org → Personal settings → App passwords).`);
      }
      if (response.status === 404) throw new Error(`Not found: ${url}`);
      throw new Error(`Bitbucket Cloud API error ${response.status} at ${url}${body ? ` — ${body}` : ''}`);
    }
    return response.json() as Promise<T>;
  }

  private async cloudRequestText(path: string): Promise<string> {
    const url = `https://api.bitbucket.org/2.0${path}`;
    const response = await fetch(url, {
      headers: { Authorization: this.authHeader, Accept: 'text/plain' },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status === 401) {
        throw new Error(`Authentication failed (401). Run "Ticket Sidekick: Configure Bitbucket Cloud Credentials" and enter your Bitbucket username and an App Password (bitbucket.org → Personal settings → App passwords).`);
      }
      if (response.status === 404) throw new Error(`Not found: ${url}`);
      throw new Error(`Bitbucket Cloud API error ${response.status} at ${url}${body ? ` — ${body}` : ''}`);
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
    return this.dcRequestText(`/projects/${project}/repos/${repo}/pull-requests/${prId}/diff`);
  }

  async getFileContent(project: string, repo: string, path: string, commitHash: string): Promise<string> {
    if (this.authType === 'cloud') {
      return this.cloudRequestText(`/repositories/${project}/${repo}/src/${commitHash}/${path}`);
    }
    // The browse API is paginated (default limit: 25 lines). Fetch with a high limit to
    // capture most source files in one request; very large files are truncated at 5000 lines.
    const data = await this.dcRequest<{ lines: Array<{ text: string }> }>(
      `/projects/${project}/repos/${repo}/browse/${path}?at=${commitHash}&limit=5000`,
    );
    return data.lines.map((l) => l.text).join('\n');
  }
}
