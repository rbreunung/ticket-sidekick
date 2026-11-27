import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// The ticket list, cleanup and import boards write on one click, and the server cannot tell a click
// from a script. What keeps that safe is a page that never turns text from Jira into markup, so no
// board page may use a call that does. See docs/architecture/boards-and-sessions.md, the threat table.

const PAGES = path.resolve(__dirname, '..', '..', 'board-pages');
const SINKS = [/\.innerHTML\b/, /\.outerHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write(ln)?\s*\(/, /\beval\s*\(/, /\bnew\s+Function\s*\(/, /\.srcdoc\b/];

function pageFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? pageFiles(full) : entry.name.endsWith('.js') ? [full] : [];
  });
}

describe('the board pages', () => {
  const files = pageFiles(PAGES);

  it('are found, so the check below looks at something', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('never build markup from a string, since the writes they trigger rest on the page staying free of injected script', () => {
    const found = files.flatMap(file => fs.readFileSync(file, 'utf8').split('\n')
      .flatMap((line, i) => SINKS.some(sink => sink.test(line)) ? [`${path.relative(PAGES, file)}:${i + 1}: ${line.trim()}`] : []));
    expect(found).toEqual([]);
  });
});
