// Shared changelog-notes helpers, used by both the release workflow (via the CLI entry
// point below) and scripts/backfill-changelog.mjs — the single source of truth for how
// GitHub's generated-notes attribution ("by @author in #123" / "by @author in <url>") is
// stripped, so the per-release CHANGELOG.md entry (release.yml) and the backfilled ones
// (backfill-changelog.mjs) can never drift out of formatting sync.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Strips GitHub's generated "by @author in #123" / "by @author in <url>" attribution
 * from each bullet line, leaving the rest of the text untouched.
 * @param {string} body
 */
export function stripAttribution(body) {
  return body.replace(/ by @[A-Za-z0-9_-]+ in (#\d+|https:\/\/\S+)/g, '');
}

// CLI: `node scripts/changelogNotes.mjs strip` reads notes text from stdin and writes the
// attribution-stripped text to stdout. release.yml's "Update CHANGELOG.md" step shells out
// to this instead of re-implementing the pattern in sed.
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function cli() {
  const command = process.argv[2];
  if (command === 'strip') {
    const input = await readStdin();
    process.stdout.write(stripAttribution(input));
    return;
  }
  console.error('Usage: node scripts/changelogNotes.mjs strip < notes.md');
  process.exitCode = 1;
}

const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  cli();
}
