import { describe, it, expect, afterEach } from 'vitest';
import { ticketFromBranch, noBranchKeyMessage } from '../tools/branchTicket';
import { makeRepoOnBranch, makeTempDir, removeTempDirs } from './helpers/gitRepo';

// The key is read from the real `git branch --show-current` of a throwaway repository.

afterEach(removeTempDirs);

describe('ticketFromBranch', () => {
  it('takes the key from the branch of the first workspace folder and names folder and branch', async () => {
    const first = makeRepoOnBranch('feature/PROJ-123-login');
    const second = makeRepoOnBranch('feature/OTHER-9-x');

    expect(await ticketFromBranch([first, second])).toEqual({ kind: 'found', folder: first, branch: 'feature/PROJ-123-login', key: 'PROJ-123' });
  });

  it('says the branch holds no key on main', async () => {
    const repo = makeRepoOnBranch('main');

    const result = await ticketFromBranch([repo]);

    expect(result).toEqual({ kind: 'no-key', folder: repo, branch: 'main' });
    if (result.kind !== 'no-key') return;
    expect(noBranchKeyMessage(result, 'jira_view_ticket')).toBe(
      `No ticket key was given, and the git branch \`main\` of the workspace folder \`${repo}\` holds no ticket key. `
      + 'Call jira_view_ticket again with a ticket key, e.g. PROJ-123.',
    );
  });

  it('says so when no workspace folder is open', async () => {
    expect(await ticketFromBranch([])).toEqual({ kind: 'no-folder' });
  });

  it('reports a folder that is not a git repository', async () => {
    const result = await ticketFromBranch([makeTempDir('ts-nogit-')]);

    expect(result.kind).toBe('git-failed');
  });
});
