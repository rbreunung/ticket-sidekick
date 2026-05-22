export function htmlToMarkdown(html: string, inlineImageMap: Map<string, string> = new Map()): string {
  let s = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');

  // Decode &amp; first so the remaining entities are intact
  s = s.replace(/&amp;/g, '\x00AMP\x00');
  // Decode angle-bracket entities early using placeholders to prevent tag-strip interference
  s = s
    .replace(/&lt;/g, '\x00LT\x00')
    .replace(/&gt;/g, '\x00GT\x00')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Tables (process before headings to avoid header-row confusion)
  s = s.replace(/<table[\s\S]*?<\/table>/gi, (table) => {
    const rows: string[][] = [];
    table.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_: string, row: string) => {
      const cells: string[] = [];
      row.replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, (_2: string, cell: string) => {
        cells.push(stripTags(cell).trim().replace(/\|/g, '\\|'));
        return '';
      });
      if (cells.length) rows.push(cells);
      return '';
    });
    if (rows.length === 0) return '';
    const sep = rows[0].map(() => '---');
    const lines = [
      `| ${rows[0].join(' | ')} |`,
      `| ${sep.join(' | ')} |`,
      ...rows.slice(1).map(r => `| ${r.join(' | ')} |`),
    ];
    return '\n' + lines.join('\n') + '\n';
  });

  // Headings
  for (let i = 6; i >= 1; i--) {
    s = s.replace(new RegExp(`<h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, 'gi'),
      (_: string, c: string) => `\n${'#'.repeat(i)} ${stripTags(c).trim()}\n`);
  }

  // Code blocks (pre+code before inline code)
  s = s.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, '\n```\n$1\n```\n');
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

  // Bold / italic (process before stripping remaining tags)
  s = s.replace(/<(?:b|strong)[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, '**$1**');
  s = s.replace(/<(?:i|em)[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, '_$1_');

  // Links
  s = s.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // Inline images: cid: references
  s = s.replace(/<img[^>]+src="cid:([^"]*)"[^>]*\/?>/gi, (_: string, cid: string) => {
    const filename = inlineImageMap.get(cid.trim()) ?? cid.trim();
    return `[📎 ${filename}]`;
  });
  // Other images: use alt text
  s = s.replace(/<img[^>]*alt="([^"]*)"[^>]*\/?>/gi, '[$1]');
  s = s.replace(/<img[^>]*\/?>/gi, '');

  // Unordered lists
  s = s.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_: string, content: string) =>
    content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_2: string, item: string) =>
      `- ${stripTags(item).trim()}\n`));

  // Ordered lists
  s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_: string, content: string) => {
    let n = 0;
    return content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_2: string, item: string) =>
      `${++n}. ${stripTags(item).trim()}\n`);
  });

  // Paragraphs / line breaks
  s = s.replace(/<\/p>/gi, '\n\n').replace(/<p[^>]*>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');

  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, '');

  // Restore placeholders decoded before tag stripping
  s = s.replace(/\x00AMP\x00/g, '&').replace(/\x00LT\x00/g, '<').replace(/\x00GT\x00/g, '>');

  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}
