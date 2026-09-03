#!/usr/bin/env node
// One-off (but re-runnable) utility that seeds CHANGELOG.md from existing GitHub Releases.
//
// Reads every non-prerelease GitHub Release, strips the "by @author in #PR" attribution
// GitHub's generator appends per line (the same stripping the release workflow applies —
// see .github/workflows/release.yml's "Update CHANGELOG.md" step), and writes one
// `## [tag] - date` section per release into CHANGELOG.md, newest first.
//
// Safe to re-run: it always rebuilds CHANGELOG.md from the current release history rather
// than appending to it, so a second run never produces duplicate entries.
//
// Usage: node scripts/backfill-changelog.mjs
// Requires: the `gh` CLI, authenticated against this repo.
//
// `gh release list --json` does not expose a release's body text (only tagName,
// isPrerelease, publishedAt, etc.) — so each stable release's notes are fetched
// individually via `gh release view <tag> --json body`.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CHANGELOG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'CHANGELOG.md'
);

/** @typedef {{ tagName: string, isPrerelease: boolean, body: string, publishedAt: string }} GhRelease */

/**
 * Strips GitHub's generated "by @author in #123" / "by @author in <url>" attribution
 * from each bullet line. Mirrors the sed pattern in release.yml's CHANGELOG step.
 * @param {string} body
 */
export function stripAttribution(body) {
  return body.replace(/ by @[A-Za-z0-9_-]+ in (#\d+|https:\/\/\S+)/g, '');
}

function formatDate(publishedAt) {
  return publishedAt ? publishedAt.slice(0, 10) : 'unknown-date';
}

/** @param {GhRelease} release */
function buildSection(release) {
  const heading = `## [${release.tagName}] - ${formatDate(release.publishedAt)}`;
  const body = stripAttribution(release.body ?? '').trim();
  return body ? `${heading}\n\n${body}\n` : `${heading}\n`;
}

/**
 * Builds the full backfilled CHANGELOG.md content from a `gh release list --json
 * tagName,isPrerelease,body,publishedAt` result: non-prerelease entries only, newest first.
 * @param {GhRelease[]} releases
 */
export function buildChangelog(releases) {
  const stable = releases
    .filter((r) => !r.isPrerelease)
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));
  return stable.map(buildSection).join('\n') + (stable.length ? '\n' : '');
}

function fetchReleaseSummaries() {
  const raw = execFileSync(
    'gh',
    ['release', 'list', '--json', 'tagName,isPrerelease,publishedAt', '--limit', '500'],
    { encoding: 'utf8' }
  );
  return JSON.parse(raw);
}

/** @param {string} tagName */
function fetchReleaseBody(tagName) {
  const raw = execFileSync('gh', ['release', 'view', tagName, '--json', 'body'], {
    encoding: 'utf8',
  });
  return JSON.parse(raw).body ?? '';
}

function fetchReleases() {
  const summaries = fetchReleaseSummaries();
  return summaries.map((r) => ({
    ...r,
    // Only stable releases feed the changelog (R6) — skip the body fetch for the rest.
    body: r.isPrerelease ? '' : fetchReleaseBody(r.tagName),
  }));
}

function main() {
  const releases = fetchReleases();
  writeFileSync(CHANGELOG_PATH, buildChangelog(releases), 'utf8');
  const count = releases.filter((r) => !r.isPrerelease).length;
  console.log(`Wrote ${count} stable release entr${count === 1 ? 'y' : 'ies'} to CHANGELOG.md`);
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  main();
}
