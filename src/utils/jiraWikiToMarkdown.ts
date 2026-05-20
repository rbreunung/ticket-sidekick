// Jira wiki markup → Markdown converter.
// Handles: headings, tables, lists, code/noformat blocks, quotes, panels,
// bold, monospace, strikethrough, links, mentions, color tags.

function parseCodeLang(params: string): string {
  if (!params) return '';
  const kv = params.match(/\blanguage=([^|}\s]+)/i);
  if (kv) return kv[1].toLowerCase();
  const simple = params.match(/^([a-z][a-z0-9]*)/i);
  return simple ? simple[1].toLowerCase() : '';
}

// ---------------------------------------------------------------------------
// Inline conversions (applied to all non-verbatim text)
// ---------------------------------------------------------------------------

export function applyInline(text: string): string {
  return text
    // {{mono}} → `mono`  (must come before bold so {{ isn't mistaken for **)
    .replace(/\{\{([^}\n]+)\}\}/g, '`$1`')
    // *bold* → **bold**  (not at list-item position: not followed by space at line start)
    .replace(/(?<!\*)\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?!\*)/g, '**$1**')
    // -strike- flanked by non-word chars (or line boundaries)
    .replace(/(^|(?<=\W))-([^-\n]+?)-(?=\W|$)/g, '~~$2~~')
    // [text|url] → [text](url)
    .replace(/\[([^\]|]+)\|([^\]]+)\]/g, '[$1]($2)')
    // [~username] → @username  (before bare-link rule)
    .replace(/\[~([^\]]+)\]/g, '@$1')
    // [url] bare link — negative lookahead skips already-converted [text](url)
    .replace(/\[([^\]]+)\](?!\()/g, '<$1>')
    // {color:…}text{color} → text
    .replace(/\{color:[^}]+\}([\s\S]*?)\{color\}/gi, '$1');
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

function parseCells(line: string): string[] {
  // Protect [text|url] links so the pipe doesn't split cells
  const links: string[] = [];
  const safe = line.replace(/\[[^\]]*\|[^\]]*\]/g, m => {
    links.push(m);
    return `\x03L${links.length - 1}\x03`;
  });

  let cells: string[];
  if (/^\|\|/.test(safe)) {
    // Header row delimited by ||
    cells = safe.replace(/^\|\||\|\|$/g, '').split('||');
  } else {
    // Data row delimited by |
    cells = safe.replace(/^\||\|$/g, '').split('|');
  }

  return cells.map(c =>
    links.reduce((s, link, i) => s.replace(`\x03L${i}\x03`, link), c)
  );
}

function renderTable(lines: string[]): string {
  const rows = lines.map(parseCells);
  const maxCols = Math.max(...rows.map(r => r.length));
  const sep = '| ' + Array(maxCols).fill('---').join(' | ') + ' |';
  const fmt = (cells: string[]) =>
    '| ' + cells.map(c => applyInline(c.trim())).join(' | ') + ' |';

  if (/^\|\|/.test(lines[0])) {
    return [fmt(rows[0]), sep, ...rows.slice(1).map(fmt)].join('\n');
  }
  // No header row — GFM requires one; use empty cells
  const emptyHeader = '| ' + Array(maxCols).fill(' ').join(' | ') + ' |';
  return [emptyHeader, sep, ...rows.map(fmt)].join('\n');
}

// ---------------------------------------------------------------------------
// List rendering
// ---------------------------------------------------------------------------

function renderList(lines: string[]): string {
  return lines.map(line => {
    const m = line.match(/^([*#]+)\s+(.*)/);
    if (!m) return applyInline(line);
    const depth = m[1].length - 1;
    const isOrdered = m[1][0] === '#';
    return `${'  '.repeat(depth)}${isOrdered ? '1.' : '-'} ${applyInline(m[2])}`;
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Main converter
// ---------------------------------------------------------------------------

export function jiraWikiToMarkdown(wiki: string): string {
  if (!wiki) return '';

  // Step 1: Stash verbatim code/noformat blocks behind control-char sentinels.
  // Sentinels contain no wiki markup characters so inline conversion is safe.
  const verbatim: string[] = [];
  let text = wiki.replace(
    /\{code(?::([^}]*))?\}([\s\S]*?)\{code\}|\{noformat(?::[^}]*)?\}([\s\S]*?)\{noformat\}/gi,
    (_, params, codeBody, noformatBody) => {
      const lang = codeBody !== undefined ? parseCodeLang(params ?? '') : '';
      const raw = (codeBody ?? noformatBody ?? '').replace(/\n+$/, '');
      const body = raw.startsWith('\n') ? raw : `\n${raw}`;
      verbatim.push(`\`\`\`${lang}${body}\n\`\`\``);
      return `\x02BLOCK${verbatim.length - 1}\x02`;
    }
  );

  // Step 2: Convert {quote} blocks to blockquotes
  text = text.replace(/\{quote\}([\s\S]*?)\{quote\}/gi, (_, body: string) =>
    body.trim().split('\n').map(l => `> ${l}`).join('\n')
  );

  // Step 3: Convert {panel} blocks — title as bold heading, body inline-converted
  text = text.replace(/\{panel(?::([^}]*))?\}([\s\S]*?)\{panel\}/gi, (_, params: string | undefined, body: string) => {
    const titleMatch = (params ?? '').match(/\btitle=([^|}\n]+)/i);
    const title = titleMatch ? titleMatch[1].trim() : '';
    return title ? `**${title}**\n${body.trim()}` : body.trim();
  });

  // Step 4: Process line by line — collect block-level constructs
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Heading h1.–h6.
    const hm = line.match(/^h([1-6])\.\s*(.*)/);
    if (hm) {
      out.push(`${'#'.repeat(Number(hm[1]))} ${applyInline(hm[2])}`);
      i++;
      continue;
    }

    // Horizontal rule (4+ dashes alone on the line, nothing else)
    if (/^-{4,}$/.test(line.trim())) {
      out.push('---');
      i++;
      continue;
    }

    // Table block — collect all consecutive table lines
    if (/^\|/.test(line)) {
      const block: string[] = [];
      while (i < lines.length && /^\|/.test(lines[i])) block.push(lines[i++]);
      out.push(renderTable(block));
      continue;
    }

    // List block — collect consecutive list lines (must start with * or # then whitespace)
    if (/^[*#]+\s/.test(line)) {
      const block: string[] = [];
      while (i < lines.length && /^[*#]+\s/.test(lines[i])) block.push(lines[i++]);
      out.push(renderList(block));
      continue;
    }

    // Plain line — apply inline conversions
    out.push(applyInline(line));
    i++;
  }

  // Step 5: Restore verbatim blocks
  let result = out.join('\n');
  for (let j = 0; j < verbatim.length; j++) {
    result = result.replace(`\x02BLOCK${j}\x02`, verbatim[j]);
  }

  // Step 6: Collapse 3+ consecutive newlines to 2, then trim
  return result.replace(/\n{3,}/g, '\n\n').trim();
}
