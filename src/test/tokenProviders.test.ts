import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  authentication: {
    getSession: vi.fn(),
  },
}));
vi.mock('child_process', () => ({ execSync: vi.fn() }));

import { createOutlookTokenProvider } from '../outlook/tokenProviders';
import * as vscode from 'vscode';
import { execSync } from 'child_process';

const mockConfigService = (token?: string) => ({
  getOutlookAuthProvider: () => 'token',
  getOutlookToken: vi.fn().mockResolvedValue(token),
  storeOutlookToken: vi.fn(),
} as never);

describe('azureCliProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns trimmed token from az stdout', async () => {
    vi.mocked(execSync).mockReturnValue('eyJtokenABC\n' as never);
    const provider = createOutlookTokenProvider('azure-cli', mockConfigService());
    await expect(provider()).resolves.toBe('eyJtokenABC');
  });

  it('throws az-login guidance when az is not found', async () => {
    vi.mocked(execSync).mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    const provider = createOutlookTokenProvider('azure-cli', mockConfigService());
    await expect(provider()).rejects.toThrow('az login');
  });

  it('throws az-login guidance when az reports not logged in', async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('az login required: No subscription found'); });
    const provider = createOutlookTokenProvider('azure-cli', mockConfigService());
    await expect(provider()).rejects.toThrow('az login');
  });

  it('throws generic message for other az errors', async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('some unexpected az error'); });
    const provider = createOutlookTokenProvider('azure-cli', mockConfigService());
    await expect(provider()).rejects.toThrow('Azure CLI token fetch failed');
  });
});

describe('staticTokenProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns token from ConfigService when present', async () => {
    const provider = createOutlookTokenProvider('token', mockConfigService('eyJstored'));
    await expect(provider()).resolves.toBe('eyJstored');
  });

  it('throws with guidance when no token is stored', async () => {
    const provider = createOutlookTokenProvider('token', mockConfigService(undefined));
    await expect(provider()).rejects.toThrow('Set Outlook Access Token');
  });
});

describe('vscodeProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns cached session token without showing UI', async () => {
    vi.mocked(vscode.authentication.getSession).mockResolvedValue({ accessToken: 'cached-token' } as never);
    const provider = createOutlookTokenProvider('vscode-microsoft', mockConfigService());
    await expect(provider()).resolves.toBe('cached-token');
    expect(vscode.authentication.getSession).toHaveBeenCalledWith('microsoft', expect.any(Array), expect.objectContaining({ silent: true }));
  });

  it('falls back to interactive session when no cached session', async () => {
    vi.mocked(vscode.authentication.getSession)
      .mockResolvedValueOnce(undefined as never)
      .mockResolvedValueOnce({ accessToken: 'interactive-token' } as never);
    const provider = createOutlookTokenProvider('vscode-microsoft', mockConfigService());
    await expect(provider()).resolves.toBe('interactive-token');
  });

  it('throws with az-cli guidance on AADSTS65002', async () => {
    vi.mocked(vscode.authentication.getSession)
      .mockResolvedValueOnce(undefined as never)
      .mockRejectedValueOnce(new Error('AADSTS65002: preauth restriction'));
    const provider = createOutlookTokenProvider('vscode-microsoft', mockConfigService());
    await expect(provider()).rejects.toThrow('azure-cli');
  });

  it('throws with settings guidance on platform_broker_error', async () => {
    vi.mocked(vscode.authentication.getSession)
      .mockResolvedValueOnce(undefined as never)
      .mockRejectedValueOnce(new Error('platform_broker_error'));
    const provider = createOutlookTokenProvider('vscode-microsoft', mockConfigService());
    await expect(provider()).rejects.toThrow('azure-cli');
  });
});
