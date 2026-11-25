import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import diff from 'highlight.js/lib/languages/diff';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';

// Model answers and draft comments on the review board are Markdown written by a model from pull
// request content, so they are untrusted. They are rendered here, in the extension, to a small JSON
// tree of allowed elements that the page builds element by element: no HTML string ever reaches
// the page. Raw HTML is not parsed (it stays text), images show their alt text, and only http and
// https links keep a target, which the page opens through the extension (and VS Code's own
// confirmation), never as a live link. Pure: no `vscode` import.

/** Input longer than this is shown as one plain paragraph, unparsed. */
export const MAX_MARKDOWN_CHARS = 20_000;
/** A code block longer than this is shown without highlighting. */
export const MAX_HIGHLIGHT_CHARS = 10_000;

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'emphasis'; children: MdInline[] }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'link'; href: string; children: MdInline[] }
  | { type: 'break' };

/** One run of code text; `cls` is the highlighter's class list (only `hljs-…` scopes) when it has one. */
export interface CodeSpan {
  text: string;
  cls?: string;
}

export interface MdTableCell {
  align?: 'left' | 'center' | 'right';
  children: MdInline[];
}

export interface MdListItem {
  type: 'list-item';
  children: MdBlock[];
}

export type MdBlock =
  /** `tight` marks a paragraph of a tight list, which the page shows without paragraph spacing. */
  | { type: 'paragraph'; tight?: true; children: MdInline[] }
  | { type: 'heading'; level: number; children: MdInline[] }
  | { type: 'list'; ordered: boolean; start?: number; items: MdListItem[] }
  | { type: 'code-block'; language?: string; spans: CodeSpan[] }
  | { type: 'blockquote'; children: MdBlock[] }
  | { type: 'table'; head: MdTableCell[][]; body: MdTableCell[][] };

for (const [name, lang] of Object.entries({ bash, diff, java, javascript, json, kotlin, shell, sql, typescript, xml })) {
  hljs.registerLanguage(name, lang);
}

/** Only web links keep a target; any other scheme (command:, vscode:, javascript:, data:, mailto:, file:, relative) does not. */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
// A link markdown-it does not validate is not made a link at all: its source stays text.
md.validateLink = isWebUrl;

type Token = MarkdownIt.Token;

/** Renders Markdown text to the restricted tree. */
export function renderMarkdown(text: string): MdBlock[] {
  if (text.length > MAX_MARKDOWN_CHARS) return [{ type: 'paragraph', children: [{ type: 'text', text }] }];
  const tokens = md.parse(text, {});
  return readBlocks(tokens, { i: 0 }, undefined);
}

interface Cursor { i: number }

/** Reads block tokens until the closing token of type `until` (consumed), or the end. */
function readBlocks(tokens: Token[], at: Cursor, until: string | undefined): MdBlock[] {
  const out: MdBlock[] = [];
  while (at.i < tokens.length) {
    const t = tokens[at.i++];
    if (t.type === until) break;
    switch (t.type) {
      case 'paragraph_open': {
        const children = readInlineToken(tokens[at.i]);
        at.i += 2; // inline + paragraph_close
        out.push(t.hidden ? { type: 'paragraph', tight: true, children } : { type: 'paragraph', children });
        break;
      }
      case 'heading_open': {
        const children = readInlineToken(tokens[at.i]);
        at.i += 2;
        out.push({ type: 'heading', level: Number(t.tag.slice(1)) || 1, children });
        break;
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const ordered = t.type === 'ordered_list_open';
        const items = readListItems(tokens, at, ordered ? 'ordered_list_close' : 'bullet_list_close');
        const start = ordered ? Number(t.attrGet('start') ?? 1) : undefined;
        out.push(ordered && start !== 1 ? { type: 'list', ordered, start, items } : { type: 'list', ordered, items });
        break;
      }
      case 'blockquote_open':
        out.push({ type: 'blockquote', children: readBlocks(tokens, at, 'blockquote_close') });
        break;
      case 'fence':
        out.push(codeBlock(t.content, languageOf(t.info)));
        break;
      case 'code_block':
        out.push(codeBlock(t.content, undefined));
        break;
      case 'table_open':
        out.push(readTable(tokens, at));
        break;
      default:
        // Anything else (a horizontal rule) has no allowed element and is left out.
        break;
    }
  }
  return out;
}

function readListItems(tokens: Token[], at: Cursor, close: string): MdListItem[] {
  const items: MdListItem[] = [];
  while (at.i < tokens.length) {
    const t = tokens[at.i++];
    if (t.type === close) break;
    if (t.type === 'list_item_open') items.push({ type: 'list-item', children: readBlocks(tokens, at, 'list_item_close') });
  }
  return items;
}

function readTable(tokens: Token[], at: Cursor): MdBlock {
  const head: MdTableCell[][] = [];
  const body: MdTableCell[][] = [];
  let rows = head;
  while (at.i < tokens.length) {
    const t = tokens[at.i++];
    if (t.type === 'table_close') break;
    if (t.type === 'thead_open') rows = head;
    else if (t.type === 'tbody_open') rows = body;
    else if (t.type === 'tr_open') rows.push([]);
    else if (t.type === 'th_open' || t.type === 'td_open') {
      const children = tokens[at.i]?.type === 'inline' ? readInlineToken(tokens[at.i++]) : [];
      const align = /text-align:(left|center|right)/.exec(String(t.attrGet('style') ?? ''))?.[1] as MdTableCell['align'];
      rows[rows.length - 1]?.push(align ? { align, children } : { children });
    }
  }
  return { type: 'table', head, body };
}

function readInlineToken(token: Token | undefined): MdInline[] {
  if (!token || token.type !== 'inline') return [];
  return readInlines(token.children ?? [], { i: 0 }, undefined);
}

/** Reads inline tokens until the closing token of type `until` (consumed), or the end. */
function readInlines(tokens: Token[], at: Cursor, until: string | undefined): MdInline[] {
  const out: MdInline[] = [];
  const pushText = (text: string): void => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last?.type === 'text') last.text += text;
    else out.push({ type: 'text', text });
  };
  while (at.i < tokens.length) {
    const t = tokens[at.i++];
    if (t.type === until) break;
    switch (t.type) {
      case 'code_inline':
        out.push({ type: 'code', text: t.content });
        break;
      case 'softbreak':
        pushText('\n');
        break;
      case 'hardbreak':
        out.push({ type: 'break' });
        break;
      case 'em_open':
        out.push({ type: 'emphasis', children: readInlines(tokens, at, 'em_close') });
        break;
      case 'strong_open':
        out.push({ type: 'strong', children: readInlines(tokens, at, 'strong_close') });
        break;
      case 'link_open': {
        const href = String(t.attrGet('href') ?? '');
        const children = readInlines(tokens, at, 'link_close');
        if (isWebUrl(href)) out.push({ type: 'link', href, children });
        else for (const child of children) child.type === 'text' ? pushText(child.text) : out.push(child);
        break;
      }
      case 'image':
        // An image shows its alt text only; its source is dropped.
        pushText(plainText(t.children ?? []));
        break;
      case 's_open':
      case 's_close':
        // Strikethrough has no allowed element: its text is kept, the marks are not.
        break;
      default:
        // text, text_special, html_inline (never produced with html off) and anything new: as text.
        pushText(t.content);
        break;
    }
  }
  return out;
}

function plainText(tokens: Token[]): string {
  return tokens.map(t => (t.children ? plainText(t.children) : t.type === 'softbreak' || t.type === 'hardbreak' ? '\n' : t.content)).join('');
}

/** The fence's first word, when it looks like a language name. */
function languageOf(info: string): string | undefined {
  const word = info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return /^[a-z0-9_+#.-]{1,32}$/.test(word) ? word : undefined;
}

function codeBlock(text: string, language: string | undefined): MdBlock {
  const plain: MdBlock = language ? { type: 'code-block', language, spans: [{ text }] } : { type: 'code-block', spans: [{ text }] };
  if (!language || text.length > MAX_HIGHLIGHT_CHARS || !hljs.getLanguage(language)) return plain;
  let html: string;
  try {
    html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return plain;
  }
  const spans = readHighlighted(html);
  return spans ? { type: 'code-block', language, spans } : plain;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'" };
const HL_PART = /<span class="([^"<>]*)">|<\/span>|&(amp|lt|gt|quot|#x27);|[^<&]+/y;
const HL_CLASS = /^hljs-[a-z0-9_-]+(?: [a-z0-9_-]+)*$/i;

/**
 * Reads the highlighter's HTML back into spans. It accepts only `<span class="hljs-…">`, `</span>`
 * and escaped text; anything else, or spans that do not balance, gives `undefined` so the block is
 * shown plain.
 */
export function readHighlighted(html: string): CodeSpan[] | undefined {
  const spans: CodeSpan[] = [];
  const open: string[] = [];
  HL_PART.lastIndex = 0;
  while (HL_PART.lastIndex < html.length) {
    const m = HL_PART.exec(html);
    if (!m) return undefined;
    let text: string;
    if (m[1] !== undefined) {
      if (!HL_CLASS.test(m[1])) return undefined;
      open.push(m[1]);
      continue;
    } else if (m[0] === '</span>') {
      if (!open.pop()) return undefined;
      continue;
    } else if (m[2] !== undefined) {
      text = ENTITIES[m[2]];
    } else {
      text = m[0];
    }
    const cls = open[open.length - 1];
    const last = spans[spans.length - 1];
    if (last && last.cls === cls) last.text += text;
    else spans.push(cls ? { text, cls } : { text });
  }
  return open.length === 0 ? spans : undefined;
}
