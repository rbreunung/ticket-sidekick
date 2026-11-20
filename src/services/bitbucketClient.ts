import { BitbucketApiClient } from '../bitbucket/BitbucketApiClient';
import type { BitbucketConfig } from '../bitbucket/IBitbucketClient';
import { logDiag } from '../utils/diagLog';

/**
 * The Bitbucket client for a configured Bitbucket, logging to the output channel. Cloud ignores the
 * base URL and talks to api.bitbucket.org; Data Center uses it.
 */
export function createBitbucketClient(config: Pick<BitbucketConfig, 'baseUrl' | 'authType' | 'token'>): BitbucketApiClient {
  return new BitbucketApiClient({
    baseUrl: config.baseUrl ?? '',
    authType: config.authType,
    token: config.token!,
    onDiag: (level, message, details) => logDiag('bitbucket.apiClient', level, message, details),
  });
}
