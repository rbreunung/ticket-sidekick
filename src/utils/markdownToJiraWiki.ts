export function markdownToJiraWiki(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const codeOpen = line.match(/^```(\w*)\s*$/);
    if (codeOpen) {
      const lang = codeOpen[1];
      out.push(lang ? `{code:${lang}}` : '{code}');
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        out.push(lines[i]);
        i++;
      }
      out.push('{code}');
      i++; // skip closing ```
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      out.push(`h${heading[1].length}. ${inline(heading[2])}`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(line.trim())) {
      out.push('----');
      i++;
      continue;
    }

    // Blockquote — collect consecutive > lines into one {quote} block
    if (line.startsWith('> ')) {
      out.push('{quote}');
      while (i < lines.length && lines[i].startsWith('> ')) {
        out.push(inline(lines[i].slice(2)));
        i++;
      }
      out.push('{quote}');
      continue;
    }

    // Unordered list
    const ul = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (ul) {
      const level = Math.floor(ul[1].length / 2) + 1;
      out.push('*'.repeat(level) + ' ' + inline(ul[2]));
      i++;
      continue;
    }

    // Ordered list
    const ol = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (ol) {
      const level = Math.floor(ol[1].length / 2) + 1;
      out.push('#'.repeat(level) + ' ' + inline(ol[2]));
      i++;
      continue;
    }

    // Table separator — skip
    if (/^\|[\s\-:|]+\|$/.test(line)) {
      i++;
      continue;
    }

    // Table row
    if (line.startsWith('|') && line.endsWith('|')) {
      const nextLine = lines[i + 1] ?? '';
      const isHeader = /^\|[\s\-:|]+\|$/.test(nextLine);
      const cells = line.slice(1, -1).split('|').map(c => inline(c.trim()));
      out.push(isHeader ? '||' + cells.join('||') + '||' : '|' + cells.join('|') + '|');
      i++;
      continue;
    }

    // Regular line
    out.push(inline(line));
    i++;
  }

  return out.join('\n');
}

function inline(text: string): string {
  // Protect inline code spans from further processing
  const spans: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    spans.push(`{{${code}}}`);
    return `\x00C${spans.length - 1}\x00`;
  });

  // Images before links so ![...](...) is handled first
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '!$2!');

  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '[$1|$2]');

  // Bold: ** or __ — use placeholder to avoid italic pass touching it
  text = text.replace(/\*\*(.+?)\*\*/g, '\x00B\x00$1\x00/B\x00');
  text = text.replace(/__(.+?)__/g, '\x00B\x00$1\x00/B\x00');

  // Italic: single * (not part of **)
  text = text.replace(/\*([^*\n]+)\*/g, '_$1_');

  // Strikethrough
  text = text.replace(/~~(.+?)~~/g, '-$1-');

  // Restore bold
  text = text.replace(/\x00B\x00(.+?)\x00\/B\x00/g, '*$1*');

  // Restore code spans
  text = text.replace(/\x00C(\d+)\x00/g, (_, idx) => spans[parseInt(idx, 10)]);

  return text;
}
