import { to_markdown } from 'jira2md';

function parseCodeLang(params: string): string {
  if (!params) return '';
  // {code:language=sql|...} explicit key=value form
  const kv = params.match(/\blanguage=([^|}\s]+)/i);
  if (kv) return kv[1].toLowerCase();
  // {code:sql} or {code:sql|linenumbers=true} — first token
  const simple = params.match(/^([a-z][a-z0-9]*)/i);
  return simple ? simple[1].toLowerCase() : '';
}

// Matches a complete {code}...{code} or {noformat}...{noformat} block.
const CODE_BLOCK_RE = /\{code(?::([^}]*))?\}([\s\S]*?)\{code\}|\{noformat\}([\s\S]*?)\{noformat\}/gi;

export function wikiToMarkdown(wikiMarkup: string): string {
  // jira2md treats _ as an italic marker even inside {code}/{noformat} blocks,
  // corrupting identifiers like id_client → id*client. Split on code blocks,
  // run jira2md only on the non-code segments, and wrap code content verbatim.
  const segments: string[] = [];
  let last = 0;

  for (const m of wikiMarkup.matchAll(CODE_BLOCK_RE)) {
    // text before this block
    if (m.index > last) {
      segments.push(to_markdown(wikiMarkup.slice(last, m.index)));
    }
    // code/noformat block — verbatim inside fences
    const [, codeParams, codeBody, noformatBody] = m;
    const lang = codeBody !== undefined ? parseCodeLang(codeParams ?? '') : '';
    const body = (codeBody ?? noformatBody) as string;
    // Ensure the body starts on a new line (Jira allows content immediately
    // after the closing brace: {code:sql}SELECT …{code}).
    const normalized = body.startsWith('\n') ? body : `\n${body}`;
    segments.push(`\`\`\`${lang}${normalized}\n\`\`\``);
    last = m.index + m[0].length;
  }

  // text after the last block (or the whole string if no blocks)
  if (last < wikiMarkup.length) {
    segments.push(to_markdown(wikiMarkup.slice(last)));
  }

  return segments.join('');
}

type AdfNode = {
  type?: string;
  text?: string;
  content?: unknown[];
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
};

export function formatJiraBody(node: unknown): string {
  if (typeof node === 'string') return wikiToMarkdown(node);
  if (!node || typeof node !== 'object') return '';

  const n = node as AdfNode;

  switch (n.type) {
    case 'doc':
      return (n.content ?? []).map(formatJiraBody).join('').trim();

    case 'paragraph': {
      const inner = (n.content ?? []).map(formatJiraBody).join('');
      return inner ? inner + '\n\n' : '';
    }

    case 'text': {
      let text = n.text ?? '';
      for (const mark of (n.marks ?? [])) {
        switch (mark.type) {
          case 'strong': text = `**${text}**`; break;
          case 'em': text = `_${text}_`; break;
          case 'code': text = `\`${text}\``; break;
          case 'strike': text = `~~${text}~~`; break;
          case 'link': {
            const href = (mark.attrs?.href as string) ?? '';
            text = `[${text}](${href})`;
            break;
          }
        }
      }
      return text;
    }

    case 'hardBreak':
      return '\n';

    case 'heading': {
      const level = (n.attrs?.level as number) ?? 1;
      const text = (n.content ?? []).map(formatJiraBody).join('');
      return `${'#'.repeat(level)} ${text}\n\n`;
    }

    case 'bulletList':
      return (n.content ?? [])
        .map((item) => `- ${formatJiraBody(item).trim()}`)
        .join('\n') + '\n\n';

    case 'orderedList':
      return (n.content ?? [])
        .map((item, i) => `${i + 1}. ${formatJiraBody(item).trim()}`)
        .join('\n') + '\n\n';

    case 'listItem':
      return (n.content ?? []).map(formatJiraBody).join('').trim();

    case 'codeBlock': {
      const lang = (n.attrs?.language as string) ?? '';
      const code = (n.content ?? []).map(formatJiraBody).join('');
      return `\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
    }

    case 'blockquote': {
      const inner = (n.content ?? []).map(formatJiraBody).join('').trim();
      return inner.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n';
    }

    case 'rule':
      return '---\n\n';

    case 'mention':
      return `@${(n.attrs?.text as string) ?? 'unknown'}`;

    default:
      return (n.content ?? []).map(formatJiraBody).join('');
  }
}
