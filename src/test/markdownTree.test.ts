import { describe, expect, it } from 'vitest';
import { MAX_HIGHLIGHT_CHARS, MAX_MARKDOWN_CHARS, readHighlighted, renderMarkdown, type MdBlock, type MdInline } from '../review/markdownTree';

// A model answer or a draft comment shown on the review board: the text is model output derived
// from pull request content, so it renders to a small tree of allowed elements, never to HTML.

/** Every node of the tree, blocks and inlines, depth first. */
function allNodes(blocks: MdBlock[]): Array<MdBlock | MdInline> {
  const out: Array<MdBlock | MdInline> = [];
  const visit = (node: any): void => {
    out.push(node);
    for (const key of ['children', 'items']) if (Array.isArray(node[key])) node[key].forEach(visit);
    if (node.type === 'table') for (const row of [...node.head, ...node.body]) for (const cell of row) cell.children.forEach(visit);
  };
  blocks.forEach(visit);
  return out;
}

function textOf(blocks: MdBlock[]): string {
  return allNodes(blocks).map(n => (n.type === 'text' || n.type === 'code' ? n.text : '')).join('');
}

describe('rendering a model answer as Markdown', () => {
  it('highlights a fenced Java block and shows a script tag in the same answer as text', () => {
    const tree = renderMarkdown([
      'Use a parameterised query:',
      '',
      '```java',
      'String sql = "SELECT * FROM users WHERE id = ?";',
      'public class Repo { }',
      '```',
      '',
      'Never <script>alert(1)</script> here.',
    ].join('\n'));

    const code = tree.find(b => b.type === 'code-block');
    expect(code).toMatchObject({ type: 'code-block', language: 'java' });
    if (code?.type !== 'code-block') throw new Error('no code block');
    expect(code.spans.map(s => s.text).join('')).toBe('String sql = "SELECT * FROM users WHERE id = ?";\npublic class Repo { }\n');
    expect(code.spans.some(s => s.cls?.startsWith('hljs-keyword'))).toBe(true);
    expect(code.spans.some(s => s.cls?.startsWith('hljs-string') && s.text.includes('SELECT'))).toBe(true);

    expect(textOf(tree)).toContain('Never <script>alert(1)</script> here.');
    expect(JSON.stringify(tree)).not.toMatch(/<span/);
  });

  it('renders headings, lists, emphasis, inline code, quotes and tables as their own nodes', () => {
    const tree = renderMarkdown([
      '## Why',
      '',
      '- *one* and **two**',
      '- `three`',
      '',
      '3. first',
      '',
      '> quoted',
      '',
      '| A | B |',
      '|:--|--:|',
      '| 1 | 2 |',
    ].join('\n'));

    expect(tree[0]).toMatchObject({ type: 'heading', level: 2, children: [{ type: 'text', text: 'Why' }] });
    expect(tree[1]).toMatchObject({ type: 'list', ordered: false });
    expect(tree[2]).toMatchObject({ type: 'list', ordered: true, start: 3 });
    expect(tree[3]).toMatchObject({ type: 'blockquote' });
    expect(tree[4]).toMatchObject({
      type: 'table',
      head: [[{ align: 'left', children: [{ type: 'text', text: 'A' }] }, { align: 'right' }]],
      body: [[{ children: [{ type: 'text', text: '1' }] }, { children: [{ type: 'text', text: '2' }] }]],
    });
    const types = new Set(allNodes(tree).map(n => n.type));
    for (const t of ['list-item', 'emphasis', 'strong', 'code']) expect(types.has(t as any)).toBe(true);
  });

  it('shows an image as its alt text only', () => {
    const tree = renderMarkdown('See ![the diagram](https://example.com/x.png) below.');
    expect(textOf(tree)).toBe('See the diagram below.');
    expect(JSON.stringify(tree)).not.toContain('example.com');
  });

  it.each([
    'command:workbench.action.openSettings',
    'vscode:extension/foo.bar',
    'javascript:alert(1)',
    'data:text/html,hi',
    'mailto:a@example.com',
    'file:///etc/passwd',
  ])('renders a %s link as text with no target', url => {
    const tree = renderMarkdown(`Click [here](${url}) or <${url}>.`);
    expect(allNodes(tree).some(n => n.type === 'link')).toBe(false);
    expect(textOf(tree)).toContain('here');
  });

  it('keeps an https link with its target as data', () => {
    const tree = renderMarkdown('Read [the docs](https://example.com/a?b=1) and <http://example.org>.');
    const links = allNodes(tree).filter(n => n.type === 'link');
    expect(links).toMatchObject([
      { type: 'link', href: 'https://example.com/a?b=1', children: [{ type: 'text', text: 'the docs' }] },
      { type: 'link', href: 'http://example.org' },
    ]);
  });

  it('shows input above the size cap as one plain paragraph', () => {
    const big = '# Title\n\n' + 'x'.repeat(MAX_MARKDOWN_CHARS);
    expect(renderMarkdown(big)).toEqual([{ type: 'paragraph', children: [{ type: 'text', text: big }] }]);
  });

  it('leaves a code block above its limit unhighlighted', () => {
    const body = 'int a = 1;\n'.repeat(Math.ceil(MAX_HIGHLIGHT_CHARS / 11) + 1);
    const tree = renderMarkdown('```java\n' + body + '```');
    expect(tree).toEqual([{ type: 'code-block', language: 'java', spans: [{ text: body }] }]);
  });

  it('leaves a block in a language it does not know unhighlighted', () => {
    expect(renderMarkdown('```cobol\nMOVE A TO B.\n```')).toEqual([{ type: 'code-block', language: 'cobol', spans: [{ text: 'MOVE A TO B.\n' }] }]);
  });

  it('reads only the highlighter\'s own span markup back, and nothing else', () => {
    expect(readHighlighted('<span class="hljs-keyword">int</span> a &lt; b &amp;&amp; c')).toEqual([
      { text: 'int', cls: 'hljs-keyword' },
      { text: ' a < b && c' },
    ]);
    expect(readHighlighted('<img src=x onerror=alert(1)>')).toBeUndefined();
    expect(readHighlighted('<span class="x" onclick="y">a</span>')).toBeUndefined();
    expect(readHighlighted('<span class="hljs-string">open')).toBeUndefined();
    expect(readHighlighted('a &nbsp; b')).toBeUndefined();
  });

  it.each([
    ['a multi-line link reference definition, repeated', '[a]: <b\n'.repeat(2_400)],
    ['many link reference definitions with open titles', '[x]: y "\n'.repeat(2_000)],
    ['many unmatched closing quotes', 'a" '.repeat(6_000)],
    ['many unmatched closing brackets', 'a] '.repeat(6_000)],
  ])('renders %s within the time budget', (_name, input) => {
    expect(input.length).toBeLessThanOrEqual(MAX_MARKDOWN_CHARS);
    const started = performance.now();
    renderMarkdown(input);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
