import { describe, expect, it } from 'vitest';
import { buildChangelog, stripAttribution } from '../../scripts/backfill-changelog.mjs';

describe('stripAttribution', () => {
  it('strips a "by @author in #PR" clause from a generated bullet line', () => {
    const line = '* Fix crash on load by @rbreunung in #42';
    expect(stripAttribution(line)).toBe('* Fix crash on load');
  });

  it('strips a "by @author in <url>" clause', () => {
    const line =
      '* Add feature by @rbreunung in https://github.com/rbreunung/ticket-sidekick/pull/42';
    expect(stripAttribution(line)).toBe('* Add feature');
  });

  it('leaves text with no attribution clause unchanged', () => {
    const line = '**Full Changelog**: https://github.com/owner/repo/compare/0.1.0...0.2.0';
    expect(stripAttribution(line)).toBe(line);
  });
});

describe('buildChangelog', () => {
  it('produces one entry per non-prerelease release, newest first, attribution stripped', () => {
    const releases = [
      {
        tagName: '0.1.0',
        isPrerelease: false,
        body: '* Initial release by @rbreunung in #1',
        publishedAt: '2026-01-01T00:00:00Z',
      },
      {
        tagName: '0.2.0',
        isPrerelease: false,
        body: '* Add feature by @rbreunung in #2',
        publishedAt: '2026-02-01T00:00:00Z',
      },
    ];

    const changelog = buildChangelog(releases);
    const entryOrder = [...changelog.matchAll(/^## \[(.+?)\]/gm)].map((m) => m[1]);

    expect(entryOrder).toEqual(['0.2.0', '0.1.0']);
    expect(changelog).not.toContain('by @rbreunung');
    expect(changelog).toContain('## [0.2.0] - 2026-02-01');
    expect(changelog).toContain('## [0.1.0] - 2026-01-01');
  });

  it('still produces a heading, not an error, for a release with a minimal/empty body', () => {
    const releases = [
      { tagName: '0.0.2', isPrerelease: false, body: '', publishedAt: '2025-01-01T00:00:00Z' },
    ];

    const changelog = buildChangelog(releases);

    expect(changelog).toContain('## [0.0.2] - 2025-01-01');
  });

  it('excludes releases marked as prerelease', () => {
    const releases = [
      {
        tagName: '0.1.0',
        isPrerelease: false,
        body: 'stable',
        publishedAt: '2026-01-01T00:00:00Z',
      },
      {
        tagName: '0.0.4',
        isPrerelease: true,
        body: 'PR Review Test 1',
        publishedAt: '2025-06-01T00:00:00Z',
      },
    ];

    const changelog = buildChangelog(releases);

    expect(changelog).toContain('0.1.0');
    expect(changelog).not.toContain('0.0.4');
    expect(changelog).not.toContain('PR Review Test 1');
  });

  it('is idempotent: rebuilding from the same release list twice yields identical output', () => {
    const releases = [
      { tagName: '0.1.0', isPrerelease: false, body: 'notes', publishedAt: '2026-01-01T00:00:00Z' },
    ];

    expect(buildChangelog(releases)).toBe(buildChangelog(releases));
  });
});
