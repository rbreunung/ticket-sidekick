import { beforeEach, describe, expect, it } from 'vitest';
import { ReviewStartScreen } from '../boards/review/startScreen';

// The review start screen of the Command Palette: the developer pastes a pull request link and the
// review board opens for it. A link that is not a Bitbucket pull request is refused with the reason,
// and nothing opens while Bitbucket is not configured.

let opened: Array<{ url: string }>;
let hint: string | undefined;
let openAnswer: { ok: true; title: string } | { ok: false; reason: string };

function screen(): ReviewStartScreen {
  return new ReviewStartScreen({
    bitbucketHint: async () => hint,
    openReview: async input => { opened.push(input); return openAnswer; },
  });
}

beforeEach(() => {
  opened = [];
  hint = undefined;
  openAnswer = { ok: true, title: 'Review: PROJ/app#482' };
});

describe('the review start screen', () => {
  it('opens the review board for a pull request link, by its normalised address', async () => {
    const view = await screen().handle('open', { url: ' https://bitbucket.example.com/projects/PROJ/repos/app/pull-requests/482/overview ' });
    expect(opened).toEqual([{ url: 'https://bitbucket.example.com/projects/PROJ/repos/app/pull-requests/482' }]);
    expect(view).toMatchObject({ opened: 'Review: PROJ/app#482' });
    expect(view.problem).toBeUndefined();
  });

  it('opens a Bitbucket Cloud pull request link', async () => {
    await screen().handle('open', { url: 'https://bitbucket.org/team/app/pull-requests/7/diff' });
    expect(opened).toEqual([{ url: 'https://bitbucket.org/team/app/pull-requests/7' }]);
  });

  it('refuses a link that is not a Bitbucket pull request, keeps it on show and says why', async () => {
    const view = await screen().handle('open', { url: 'https://bitbucket.example.com/projects/PROJ/repos/app/browse/src' });
    expect(opened).toEqual([]);
    expect(view.url).toBe('https://bitbucket.example.com/projects/PROJ/repos/app/browse/src');
    expect(view.problem).toMatch(/not the link of a Bitbucket pull request/);
  });

  it('refuses text that is not a web address', async () => {
    const view = await screen().handle('open', { url: 'PR 482 please' });
    expect(opened).toEqual([]);
    expect(view.problem).toMatch(/is not a web address/);
  });

  it('opens nothing while Bitbucket is not configured and shows the setup hint', async () => {
    hint = 'Bitbucket is not configured.';
    const s = screen();
    expect(await s.handle('view', {})).toMatchObject({ bitbucketHint: 'Bitbucket is not configured.' });
    const view = await s.handle('open', { url: 'https://bitbucket.org/team/app/pull-requests/7' });
    expect(opened).toEqual([]);
    expect(view.problem).toBe('Bitbucket is not configured.');
  });

  it('says why the board did not open', async () => {
    openAnswer = { ok: false, reason: 'there is no board of that name.' };
    const view = await screen().handle('open', { url: 'https://bitbucket.org/team/app/pull-requests/7' });
    expect(view.problem).toBe('The review was not opened: there is no board of that name.');
  });

  it('refuses an unknown request', async () => {
    await expect(screen().handle('delete', {})).rejects.toThrow('Unknown request.');
  });
});
