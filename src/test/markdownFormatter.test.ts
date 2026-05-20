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

  it('closing fence is on its own line when body ends with a newline', () => {
    const result = wikiToMarkdown('{code:sql}\nSELECT 1;\n{code}');
    expect(result).toMatch(/SELECT 1;\n```/);
    expect(result).not.toMatch(/SELECT 1;```/);
  });

  it('closing fence is on its own line when body has no trailing newline', () => {
    const result = wikiToMarkdown('{code:sql}SELECT 1;{code}');
    expect(result).toMatch(/SELECT 1;\n```/);
    expect(result).not.toMatch(/SELECT 1;```/);
  });

  // --- headings ---
  it('converts h1. heading', () => {
    expect(wikiToMarkdown('h1. My Heading')).toContain('# My Heading');
  });

  it('converts h3. heading', () => {
    expect(wikiToMarkdown('h3. Sub section')).toContain('### Sub section');
  });

  it('applies inline markup inside a heading', () => {
    expect(wikiToMarkdown('h2. Check *this* out')).toContain('## Check **this** out');
  });

  // --- tables ---
  it('renders a table with header row', () => {
    const result = wikiToMarkdown('||A||B||\n|1|2|');
    expect(result).toContain('| A | B |');
    expect(result).toContain('| --- |');
    expect(result).toContain('| 1 | 2 |');
  });

  it('renders a table without header row by inserting a synthetic separator', () => {
    const result = wikiToMarkdown('|a|b|\n|c|d|');
    expect(result).toContain('| --- |');
    expect(result).toContain('| a | b |');
    expect(result).toContain('| c | d |');
  });

  it('applies inline markup inside a table cell', () => {
    const result = wikiToMarkdown('||Name||\n|*bold*|');
    expect(result).toContain('**bold**');
  });

  // --- inline markup ---
  it('converts strikethrough -text-', () => {
    expect(wikiToMarkdown('-strike-')).toContain('~~strike~~');
  });

  it('converts a labelled link [text|url]', () => {
    expect(wikiToMarkdown('[Click here|https://example.com]')).toContain('[Click here](https://example.com)');
  });

  it('converts a bare link [url]', () => {
    expect(wikiToMarkdown('[https://example.com]')).toContain('<https://example.com>');
  });

  it('converts a mention [~username]', () => {
    expect(wikiToMarkdown('[~jsmith]')).toContain('@jsmith');
  });

  it('strips {color} tags and keeps content', () => {
    expect(wikiToMarkdown('{color:red}important{color}')).toContain('important');
    expect(wikiToMarkdown('{color:red}important{color}')).not.toContain('{color');
  });

  // --- lists ---
  it('converts bullet list items', () => {
    const result = wikiToMarkdown('* Alpha\n* Beta');
    expect(result).toContain('- Alpha');
    expect(result).toContain('- Beta');
  });

  it('indents nested bullet list items', () => {
    const result = wikiToMarkdown('* Parent\n** Child');
    expect(result).toContain('- Parent');
    expect(result).toContain('  - Child');
  });

  it('converts numbered list items', () => {
    const result = wikiToMarkdown('# One\n# Two');
    expect(result).toContain('1. One');
    expect(result).toContain('1. Two');
  });

  // --- horizontal rule ---
  it('converts ---- to a horizontal rule', () => {
    expect(wikiToMarkdown('----')).toContain('---');
  });

  // --- multiple blocks ---
  it('handles two code blocks in one string, both verbatim', () => {
    const wiki = '{code:sql}\nSELECT a_b;\n{code}\nsome text\n{code:java}\nint a_b = 1;\n{code}';
    const result = wikiToMarkdown(wiki);
    expect(result).toContain('a_b');
    expect(result).not.toContain('a*b');
  });

  // --- edge cases ---
  it('returns empty string for empty input', () => {
    expect(wikiToMarkdown('')).toBe('');
  });
});

describe('formatJiraBody — ADF codeBlock closing fence', () => {
  it('closing fence is on its own line', () => {
    const node = {
      type: 'doc',
      content: [{
        type: 'codeBlock',
        attrs: { language: 'sql' },
        content: [{ type: 'text', text: 'SELECT 1;' }],
      }],
    };
    const result = formatJiraBody(node);
    expect(result).toMatch(/SELECT 1;\n```/);
    expect(result).not.toMatch(/SELECT 1;```/);
  });

  it('closing fence is on its own line when ADF text node already has trailing newline', () => {
    const node = {
      type: 'doc',
      content: [{
        type: 'codeBlock',
        attrs: { language: 'sql' },
        content: [{ type: 'text', text: 'SELECT 1;\n' }],
      }],
    };
    const result = formatJiraBody(node);
    expect(result).toMatch(/SELECT 1;\n```/);
    expect(result).not.toMatch(/SELECT 1;```/);
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
