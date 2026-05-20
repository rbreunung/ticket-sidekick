import { describe, it, expect } from 'vitest';
import { formatJiraBody, wikiToMarkdown } from '../utils/markdownFormatter';

describe('wikiToMarkdown', () => {
  it('converts Jira wiki bold to markdown bold', () => {
    expect(wikiToMarkdown('*bold text*')).toContain('**bold text**');
  });

  it('converts Jira wiki monospace to inline code', () => {
    expect(wikiToMarkdown('{{mono}}')).toContain('`mono`');
  });

  it('converts a Jira code block to a fenced code block', () => {
    const result = wikiToMarkdown('{code:java}\nSystem.out.println();\n{code}');
    expect(result).toContain('```');
    expect(result).toContain('System.out.println();');
  });

  it('ensures newline after opening fence when content follows on the same line', () => {
    const result = wikiToMarkdown('{code:json}"key": "value"\n{code}');
    expect(result).toMatch(/```json\n/);
    expect(result).not.toMatch(/```json"/);
  });

  it('passes plain text through unchanged', () => {
    expect(wikiToMarkdown('plain text')).toContain('plain text');
  });

  it('preserves underscores in SQL identifiers inside a {code} block verbatim', () => {
    const wiki = '{code:sql}\nselect id_client, id_master_client from clients;\n{code}';
    const result = wikiToMarkdown(wiki);
    expect(result).toContain('id_client');
    expect(result).toContain('id_master_client');
    expect(result).not.toContain('id*client');
    expect(result).not.toContain('id*master*client');
  });

  it('preserves underscores inside a {noformat} block verbatim', () => {
    const wiki = '{noformat}\nsome_var and another_var\n{noformat}';
    const result = wikiToMarkdown(wiki);
    expect(result).toContain('some_var');
    expect(result).toContain('another_var');
    expect(result).not.toContain('some*var');
  });

  it('still converts wiki italic outside code blocks', () => {
    const wiki = '_italic text_ and {code}\nnot_italic\n{code}';
    const result = wikiToMarkdown(wiki);
    expect(result).toMatch(/_italic text_|\*italic text\*/);
    expect(result).toContain('not_italic');
  });
});

describe('formatJiraBody', () => {
  describe('v2 string input (wiki markup)', () => {
    it('delegates to wikiToMarkdown for string input', () => {
      expect(formatJiraBody('*bold*')).toContain('**bold**');
    });
  });

  describe('null / missing input', () => {
    it('returns empty string for null', () => {
      expect(formatJiraBody(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(formatJiraBody(undefined)).toBe('');
    });

    it('returns empty string for a non-object non-string', () => {
      expect(formatJiraBody(42)).toBe('');
    });
  });

  describe('ADF paragraph', () => {
    it('renders a simple paragraph', () => {
      const node = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] },
        ],
      };
      expect(formatJiraBody(node)).toBe('Hello world');
    });

    it('separates two paragraphs with a blank line', () => {
      const node = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] },
        ],
      };
      expect(formatJiraBody(node)).toMatch(/First\n\nSecond/);
    });
  });

  describe('ADF text marks', () => {
    it('wraps strong mark in **', () => {
      const node = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'bold', marks: [{ type: 'strong' }] }] },
        ],
      };
      expect(formatJiraBody(node)).toContain('**bold**');
    });

    it('wraps em mark in _', () => {
      const node = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'italic', marks: [{ type: 'em' }] }] },
        ],
      };
      expect(formatJiraBody(node)).toContain('_italic_');
    });

    it('wraps code mark in backticks', () => {
      const node = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'fn()', marks: [{ type: 'code' }] }] },
        ],
      };
      expect(formatJiraBody(node)).toContain('`fn()`');
    });

    it('wraps strike mark in ~~', () => {
      const node = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'old', marks: [{ type: 'strike' }] }] },
        ],
      };
      expect(formatJiraBody(node)).toContain('~~old~~');
    });

    it('renders a link mark', () => {
      const node = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'click here',
                marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
              },
            ],
          },
        ],
      };
      expect(formatJiraBody(node)).toContain('[click here](https://example.com)');
    });
  });

  describe('ADF heading', () => {
    it('renders h1 with one hash', () => {
      const node = {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        ],
      };
      expect(formatJiraBody(node)).toContain('# Title');
    });

    it('renders h2 with two hashes', () => {
      const node = {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Section' }] },
        ],
      };
      expect(formatJiraBody(node)).toContain('## Section');
    });
  });

  describe('ADF lists', () => {
    it('renders bullet list items with -', () => {
      const node = {
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Alpha' }] }] },
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Beta' }] }] },
            ],
          },
        ],
      };
      const result = formatJiraBody(node);
      expect(result).toContain('- Alpha');
      expect(result).toContain('- Beta');
    });

    it('renders ordered list items with numbers', () => {
      const node = {
        type: 'doc',
        content: [
          {
            type: 'orderedList',
            content: [
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Step one' }] }] },
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Step two' }] }] },
            ],
          },
        ],
      };
      const result = formatJiraBody(node);
      expect(result).toContain('1. Step one');
      expect(result).toContain('2. Step two');
    });
  });

  describe('ADF code block', () => {
    it('renders a fenced code block with language', () => {
      const node = {
        type: 'doc',
        content: [
          {
            type: 'codeBlock',
            attrs: { language: 'typescript' },
            content: [{ type: 'text', text: 'const x = 1;' }],
          },
        ],
      };
      const result = formatJiraBody(node);
      expect(result).toContain('```typescript');
      expect(result).toContain('const x = 1;');
      expect(result).toContain('```');
    });

    it('renders a fenced code block without language', () => {
      const node = {
        type: 'doc',
        content: [
          {
            type: 'codeBlock',
            attrs: {},
            content: [{ type: 'text', text: 'some code' }],
          },
        ],
      };
      expect(formatJiraBody(node)).toContain('```\nsome code\n```');
    });
  });

  describe('ADF misc nodes', () => {
    it('renders hardBreak as newline', () => {
      const node = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Line one' },
              { type: 'hardBreak' },
              { type: 'text', text: 'Line two' },
            ],
          },
        ],
      };
      expect(formatJiraBody(node)).toContain('Line one\nLine two');
    });

    it('renders mention as @Name', () => {
      const node = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'mention', attrs: { text: 'Jane Doe' } }] },
        ],
      };
      expect(formatJiraBody(node)).toContain('@Jane Doe');
    });

    it('renders blockquote with > prefix', () => {
      const node = {
        type: 'doc',
        content: [
          {
            type: 'blockquote',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] },
            ],
          },
        ],
      };
      expect(formatJiraBody(node)).toContain('> quoted');
    });

    it('renders horizontal rule as ---', () => {
      const node = { type: 'doc', content: [{ type: 'rule' }] };
      expect(formatJiraBody(node)).toContain('---');
    });

    it('falls back to extracting text for unknown node types', () => {
      const node = {
        type: 'doc',
        content: [
          {
            type: 'unknownFutureType',
            content: [{ type: 'text', text: 'fallback text' }],
          },
        ],
      };
      expect(formatJiraBody(node)).toContain('fallback text');
    });
  });
});
