export function htmlToMarkdown(html: string, inlineImageMap: Map<string, string> = new Map()): string {
  html = html.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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

  // Tables, innermost first (process before headings to avoid header-row confusion).
  // A table whose cells hold line breaks (e.g. a signature layout) is unwrapped into
  // its cells' own content, one after another, for the rest of the pipeline to convert.
  const innermostTable = /<table(?:\s[^>]*)?>(?:(?!<table[\s>])[\s\S])*?<\/table>/gi;
  for (let prev = ''; prev !== s;) {
    prev = s;
    s = s.replace(innermostTable, (table) => {
      const rows: string[][] = [];
      table.replace(/<tr(?:\s[^>]*)?>([\s\S]*?)<\/tr>/gi, (_: string, row: string) => {
        const cells: string[] = [];
        row.replace(/<t[hd](?:\s[^>]*)?>([\s\S]*?)<\/t[hd]>/gi, (_2: string, cell: string) => {
          cells.push(cell);
          return '';
        });
        if (cells.length) rows.push(cells);
        return '';
      });
      if (rows.length === 0) return '';
      if (rows.some(r => r.some(c => LINE_BREAK_TAG.test(c)))) {
        const cells = rows.flat().filter(c => stripTags(c).trim() || /<img/i.test(c));
        return `<br>${cells.join('<br>')}<br>`;
      }
      const text = rows.map(r => r.map(c => stripTags(convertImages(c, inlineImageMap)).trim().replace(/\|/g, '\\|')));
      const sep = text[0].map(() => '---');
      const lines = [
        `| ${text[0].join(' | ')} |`,
        `| ${sep.join(' | ')} |`,
        ...text.slice(1).map(r => `| ${r.join(' | ')} |`),
      ];
      return '\n' + lines.join('\n') + '\n';
    });
  }

  // Headings
  for (let i = 6; i >= 1; i--) {
    s = s.replace(new RegExp(`<h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, 'gi'),
      (_: string, c: string) => `\n${'#'.repeat(i)} ${stripTags(c).trim()}\n`);
  }

  // Code blocks (pre+code before inline code)
  s = s.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, '\n```\n$1\n```\n');
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```noformat\n$1\n```\n');
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

  // Bold / italic (process before stripping remaining tags)
  // Each line of a run spanning a line break is wrapped separately
  s = s.replace(/<(b|strong)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_: string, _t: string, c: string) => wrapLines(c, '**'));
  s = s.replace(/<(i|em)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_: string, _t: string, c: string) => wrapLines(c, '_'));

  // Links
  s = s.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  s = convertImages(s, inlineImageMap);
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
  s = s.replace(/(?:<\/div>\s*)+/gi, '\n').replace(/<hr(?:\s[^>]*)?>/gi, '\n').replace(/<\/tr>/gi, '\n');

  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, '');

  // Restore placeholders decoded before tag stripping
  s = s.replace(/\x00AMP\x00/g, '&').replace(/\x00LT\x00/g, '<').replace(/\x00GT\x00/g, '>');

  // Trim whitespace inside bold/italic markers that leaked from stripped wrapper tags
  // e.g. <b><span>\ntext</span></b> → **\ntext** → **text**
  s = s.replace(/\*\*([\s\S]*?)\*\*/g, (_, c) => { const t = c.trim(); return t ? `**${t}**` : ''; });
  s = s.replace(/_([\s\S]*?)_/g, (_, c) => { const t = c.trim(); return t ? `_${t}_` : ''; });

  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

const LINE_BREAK_TAG = /<br[\s/>]|<\/(?:p|div|tr|li)>|<hr[\s/>]/i;

function wrapLines(content: string, marker: string): string {
  return content.split(/(<br\s*\/?>|<\/(?:p|div)>)/i)
    .map((part, i) => (i % 2 ? part : `${marker}${part}${marker}`))
    .join('');
}

// Inline images become `[📎 name]` markers so the email flows can match them to attachments
function convertImages(html: string, inlineImageMap: Map<string, string>): string {
  // data-ts-filename (OWA Tampermonkey bridge) before the cid: rule; the alt-text fallback runs afterwards in htmlToMarkdown
  return html
    .replace(/<img[^>]+data-ts-filename="([^"]*)"[^>]*\/?>/gi, (_: string, filename: string) => `[📎 ${filename}]`)
    .replace(/<img[^>]+src="cid:([^"]*)"[^>]*\/?>/gi, (_: string, cid: string) =>
      `[📎 ${inlineImageMap.get(cid.trim()) ?? cid.trim()}]`);
}
