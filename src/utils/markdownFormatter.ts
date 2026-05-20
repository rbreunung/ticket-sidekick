import { jiraWikiToMarkdown } from './jiraWikiToMarkdown';

export function wikiToMarkdown(wikiMarkup: string): string {
  return jiraWikiToMarkdown(wikiMarkup);
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
      const code = (n.content ?? []).map(formatJiraBody).join('').replace(/\n+$/, '');
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
