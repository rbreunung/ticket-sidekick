import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { parseEmlFile } from '../utils/emlParser';
import { htmlToMarkdown } from '../utils/htmlToMarkdown';
import {
  BLOCK_LINE_CAP,
  BoilerplatePattern,
  DetectedBlock,
  detectBlocks,
  detectPatternBlocks,
  normalizePhrase,
  splitSegments,
} from '../utils/emailBoilerplate';

const fixture = (name: string) => path.resolve(process.cwd(), 'src/test/fixtures/eml', name);

async function load(name: string) {
  return parseEmlFile(fixture(name));
}

function blockText(body: string, b: DetectedBlock): string[] {
  return body.split('\n').slice(b.startLine, b.endLine + 1);
}

const DISCLAIMER_EN: BoilerplatePattern = { kind: 'footer', start: 'CONFIDENTIALITY NOTICE:' };

describe('splitSegments — reply-header recognition', () => {
  it('splits an English OWA chain into one segment per message, with each sender name', async () => {
    const mail = await load('chain-owa-en.eml');
    const segments = splitSegments(mail.markdownBody, mail.senderName);
    expect(segments.map(s => s.senderName)).toEqual(['Alice Top', 'Bob Middle', 'Carol Third', 'Dave Fourth']);
    const lines = mail.markdownBody.split('\n');
    // Every quoted segment starts on its bold reply header; the body starts after it
    for (const s of segments.slice(1)) {
      expect(lines[s.startLine]).toMatch(/^\*\*From:\*\*/);
      expect(lines[s.bodyStartLine - 1]).toMatch(/^\*\*Subject:\*\*/);
    }
    // Segments tile the whole body
    expect(segments[0].startLine).toBe(0);
    expect(segments[segments.length - 1].endLine).toBe(lines.length - 1);
    for (let i = 1; i < segments.length; i++) expect(segments[i].startLine).toBe(segments[i - 1].endLine + 1);
  });

  it('splits a German OWA chain (Von/Gesendet/An/Betreff) into the right number of segments', async () => {
    const mail = await load('chain-owa-de.eml');
    const segments = splitSegments(mail.markdownBody, mail.senderName);
    expect(segments).toHaveLength(3);
    expect(segments.map(s => s.senderName)).toEqual(['Anna Schmidt', 'Bernd Weber', 'Clara Neumann']);
  });

  it('splits a plain-text chain at -----Original Message----- and -----Ursprüngliche Nachricht-----', async () => {
    const mail = await load('chain-plaintext.eml');
    const segments = splitSegments(mail.markdownBody, mail.senderName);
    const lines = mail.markdownBody.split('\n');
    expect(segments).toHaveLength(3);
    expect(lines[segments[1].startLine]).toBe('-----Original Message-----');
    expect(lines[segments[2].startLine]).toBe('-----Ursprüngliche Nachricht-----');
    expect(segments.map(s => s.senderName)).toEqual(['Erik Plain', 'Fiona Text', 'Gerd Alt']);
  });

  it('leaves the top segment without a sender name when the caller supplies none', async () => {
    const mail = await load('chain-owa-de.eml');
    expect(splitSegments(mail.markdownBody)[0].senderName).toBeUndefined();
  });

  it('does not treat a lone "From:" line without Sent/Date and To/Subject as a reply header', () => {
    const body = htmlToMarkdown('<div>From: the desk of the CFO</div><div>please approve.</div>');
    expect(splitSegments(body)).toHaveLength(1);
  });

  it('returns a single empty segment for an empty body', () => {
    const segments = splitSegments('');
    expect(segments).toHaveLength(1);
    expect(detectPatternBlocks('', [DISCLAIMER_EN])).toEqual([]);
  });
});

describe('detectPatternBlocks — thread-wide detection (R2, R4)', () => {
  it('AE2: an English OWA chain with the disclaimer under four messages yields four footer blocks, one per segment', async () => {
    const mail = await load('chain-owa-en.eml');
    const blocks = detectPatternBlocks(mail.markdownBody, [DISCLAIMER_EN], mail.senderName);
    expect(blocks).toHaveLength(4);
    expect(blocks.map(b => b.segmentIndex)).toEqual([0, 1, 2, 3]);
    for (const b of blocks) {
      expect(b.kind).toBe('footer');
      expect(b.source).toBe('pattern');
      expect(b.patternIndex).toBe(0);
      expect(b.capped).toBe(false);
      // Without an end phrase the footer runs to its segment end: all three disclaimer lines, no trailing blank
      expect(blockText(mail.markdownBody, b)).toEqual([
        'CONFIDENTIALITY NOTICE: This e-mail and any attachments are confidential and may be legally privileged.',
        'If you are not the intended recipient, please notify the sender immediately and delete this e-mail.',
        'Example Bank AG, Registered office Frankfurt am Main.',
      ]);
      expect(b.excerpt).toBe('CONFIDENTIALITY NOTICE: This e-mail and any attachments are confidential and may be legally privileged.');
      expect(b.nonEmptyLineCount).toBe(3);
    }
  });

  it('finds the German disclaimer under every message of a German OWA chain', async () => {
    const mail = await load('chain-owa-de.eml');
    const blocks = detectPatternBlocks(mail.markdownBody,
      [{ kind: 'footer', start: 'Vertraulichkeitshinweis', end: 'löschen Sie diese E-Mail' }], mail.senderName);
    expect(blocks.map(b => b.segmentIndex)).toEqual([0, 1, 2]);
    for (const b of blocks) expect(b.nonEmptyLineCount).toBe(2);
  });

  it('finds the disclaimer in every segment of a plain-text chain', async () => {
    const mail = await load('chain-plaintext.eml');
    const blocks = detectPatternBlocks(mail.markdownBody,
      [{ kind: 'footer', start: 'This message is confidential.' }], mail.senderName);
    expect(blocks.map(b => b.segmentIndex)).toEqual([0, 1, 2]);
    for (const b of blocks) expect(b.nonEmptyLineCount).toBe(1);
  });

  it('AE7: three stacked footers at the very end stay three separate blocks, plus the signature above them', async () => {
    const mail = await load('chain-stacked-footers.eml');
    const patterns: BoilerplatePattern[] = [
      { kind: 'signature', start: 'Best regards,' },
      { kind: 'footer', start: 'LEGAL NOTICE:' },
      { kind: 'footer', start: 'CONFIDENTIALITY NOTICE:' },
      { kind: 'footer', start: 'DATA PROTECTION:' },
    ];
    const blocks = detectPatternBlocks(mail.markdownBody, patterns, mail.senderName);
    expect(blocks.map(b => b.kind)).toEqual(['signature', 'footer', 'footer', 'footer']);
    expect(blocks.map(b => b.patternIndex)).toEqual([0, 1, 2, 3]);
    const [sig, f1, f2, f3] = blocks;
    // The signature stops before the first footer instead of swallowing it
    expect(blockText(mail.markdownBody, sig)).toEqual([
      'Best regards,', 'Ivan Recipient', 'Procurement Manager', 'Phone +49 69 5555 0000', '[📎 stack-logo.png]',
    ]);
    expect(f1.excerpt).toMatch(/^LEGAL NOTICE:/);
    expect(f1.nonEmptyLineCount).toBe(2);
    expect(f2.excerpt).toMatch(/^CONFIDENTIALITY NOTICE:/);
    expect(f2.nonEmptyLineCount).toBe(2);
    expect(f3.excerpt).toMatch(/^DATA PROTECTION:/);
    expect(f3.nonEmptyLineCount).toBe(1);
    // Pattern at the very last line of the body
    expect(f3.endLine).toBe(mail.markdownBody.split('\n').length - 1);
    // No overlap
    for (let i = 1; i < blocks.length; i++) expect(blocks[i].startLine).toBeGreaterThan(blocks[i - 1].endLine);
  });

  it('AE8: a signature without end phrase above an unrecognized reply header stops at the length cap', () => {
    const quoted = Array.from({ length: 60 }, (_, i) => `<div>&gt; quoted line ${i + 1}</div>`).join('');
    const html = '<div>Hi Bob,</div><div>see below.</div><div><br></div>'
      + '<div>Best regards,<br>Alice Top<br>Senior Analyst</div><div><br></div>'
      + '<div>Le mar. 29 sept. 2026 à 10:00, Bob Middle a écrit :</div>' + quoted;
    const body = htmlToMarkdown(html);
    const blocks = detectPatternBlocks(body, [{ kind: 'signature', start: 'Best regards,' }], 'Alice Top');
    expect(blocks).toHaveLength(1);
    const [sig] = blocks;
    expect(sig.capped).toBe(true);
    expect(sig.nonEmptyLineCount).toBe(BLOCK_LINE_CAP);
    expect(BLOCK_LINE_CAP).toBe(40);
    expect(sig.endLine).toBeLessThan(body.split('\n').length - 1);
    expect(blockText(body, sig)[0]).toBe('Best regards,');
  });
});

describe('detectPatternBlocks — extent rules (KTD4)', () => {
  it('a pattern with an end phrase covers exactly the start line through the end line', async () => {
    const mail = await load('chain-owa-en.eml');
    const blocks = detectPatternBlocks(mail.markdownBody,
      [{ kind: 'footer', start: 'CONFIDENTIALITY NOTICE:', end: 'delete this e-mail.' }], mail.senderName);
    expect(blocks).toHaveLength(4);
    for (const b of blocks) {
      expect(blockText(mail.markdownBody, b)).toEqual([
        'CONFIDENTIALITY NOTICE: This e-mail and any attachments are confidential and may be legally privileged.',
        'If you are not the intended recipient, please notify the sender immediately and delete this e-mail.',
      ]);
    }
  });

  it('a start phrase whose end phrase does not follow it in the same segment produces no block there', async () => {
    const mail = await load('chain-owa-en.eml');
    // "Senior Analyst" only occurs in Alice's signature (segment 0), before Bob's "Thanks," in segment 1
    expect(detectPatternBlocks(mail.markdownBody,
      [{ kind: 'signature', start: 'Thanks,', end: 'Senior Analyst' }], mail.senderName)).toEqual([]);
    // The same end phrase does produce a block where it follows the start phrase
    const blocks = detectPatternBlocks(mail.markdownBody,
      [{ kind: 'signature', start: 'Best regards,', end: 'Senior Analyst' }], mail.senderName);
    expect(blocks).toHaveLength(1);
    expect(blockText(mail.markdownBody, blocks[0])).toEqual(['Best regards,', 'Alice Top', 'Senior Analyst, Reporting']);
  });

  it('a header pattern covers only its paragraph, including lines above the matched one', async () => {
    const mail = await load('chain-owa-en.eml');
    const blocks = detectPatternBlocks(mail.markdownBody,
      [{ kind: 'header', start: 'Do not click links' }], mail.senderName);
    expect(blocks).toHaveLength(1);
    expect(blockText(mail.markdownBody, blocks[0])).toEqual([
      '[EXTERNAL] This message originated from outside Example Bank.',
      'Do not click links or open attachments unless you recognise the sender.',
    ]);
    expect(blocks[0].excerpt).toBe('[EXTERNAL] This message originated from outside Example Bank.');
  });

  it('a signature without end phrase runs to the segment end, not into the next message', async () => {
    const mail = await load('chain-owa-en.eml');
    const blocks = detectPatternBlocks(mail.markdownBody, [{ kind: 'signature', start: 'Thanks,' }], mail.senderName);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].segmentIndex).toBe(1);
    const text = blockText(mail.markdownBody, blocks[0]);
    expect(text[0]).toBe('Thanks,');
    expect(text[text.length - 1]).toBe('Example Bank AG, Registered office Frankfurt am Main.');
    expect(text.join('\n')).not.toContain('From:');
  });

  it('a start phrase appearing twice in one segment yields two separate, non-overlapping blocks', () => {
    const body = htmlToMarkdown('<div>Hello</div><div><br></div><div>Kind regards<br>Alice</div><div><br></div>'
      + '<div>Kind regards<br>Bob</div>');
    const blocks = detectPatternBlocks(body, [{ kind: 'signature', start: 'Kind regards' }]);
    expect(blocks.map(b => blockText(body, b))).toEqual([['Kind regards', 'Alice'], ['Kind regards', 'Bob']]);
  });

  it('a start phrase appearing twice before a single end phrase yields one block from the first start', () => {
    const body = htmlToMarkdown('<div>Kind regards<br>Kind regards<br>Alice<br>END OF SIGNATURE</div>');
    const blocks = detectPatternBlocks(body, [{ kind: 'signature', start: 'Kind regards', end: 'END OF SIGNATURE' }]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startLine).toBe(0);
    expect(blocks[0].endLine).toBe(3);
  });

  it('two patterns matching the same line produce a single block (the first configured one)', async () => {
    const mail = await load('chain-plaintext.eml');
    const blocks = detectPatternBlocks(mail.markdownBody, [
      { kind: 'footer', start: 'This message is confidential' },
      { kind: 'footer', start: 'please delete it' },
    ], mail.senderName);
    expect(blocks).toHaveLength(3);
    expect(blocks.every(b => b.patternIndex === 0)).toBe(true);
  });

  it('does not match inside a reply header', async () => {
    const mail = await load('chain-owa-en.eml');
    // "Quarterly report numbers" appears only in Subject lines and in Carol's body
    const blocks = detectPatternBlocks(mail.markdownBody, [{ kind: 'header', start: 'Quarterly report numbers' }], mail.senderName);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].segmentIndex).toBe(2);
    expect(blockText(mail.markdownBody, blocks[0])).toEqual(['Hello both,', 'please find the quarterly report numbers below.']);
  });
});

describe('detectPatternBlocks — matching normalization (KTD3)', () => {
  it('ignores case, collapsed whitespace and **bold** markers around the phrase', () => {
    const body = htmlToMarkdown('<div>Body text</div><div><br></div>'
      + '<div><b>Confidentiality&nbsp;&nbsp;   Notice</b>: all content is private.</div>');
    const blocks = detectPatternBlocks(body, [{ kind: 'footer', start: 'confidentiality notice:  ALL content' }]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].excerpt).toBe('**Confidentiality     Notice**: all content is private.');
  });

  it('ignores emphasis markers inside the configured phrase as well', () => {
    const body = htmlToMarkdown('<div>Body</div><div><i>Sent from my phone</i></div>');
    expect(detectPatternBlocks(body, [{ kind: 'signature', start: '**Sent from** _my phone_' }])).toHaveLength(1);
  });

  it('matches a phrase that wraps across a line break', async () => {
    const mail = await load('chain-owa-en.eml');
    const blocks = detectPatternBlocks(mail.markdownBody,
      [{ kind: 'footer', start: 'legally privileged. If you are not' }], mail.senderName);
    expect(blocks).toHaveLength(4);
    expect(blocks[0].excerpt).toMatch(/^CONFIDENTIALITY NOTICE/);
  });

  it('normalizePhrase lower-cases, collapses whitespace and drops emphasis markers', () => {
    expect(normalizePhrase('  **Best**   _Regards_, \n Anna ')).toBe('best regards, anna');
  });
});

describe('detectPatternBlocks — nothing to find', () => {
  it('no configured patterns yield an empty detection list', async () => {
    const mail = await load('chain-owa-en.eml');
    expect(detectPatternBlocks(mail.markdownBody, [], mail.senderName)).toEqual([]);
  });

  it('patterns that match nothing yield an empty detection list', async () => {
    const mail = await load('chain-owa-de.eml');
    expect(detectPatternBlocks(mail.markdownBody, [DISCLAIMER_EN], mail.senderName)).toEqual([]);
  });

  it('an entry whose start phrase is blank after normalization is ignored', async () => {
    const mail = await load('chain-owa-en.eml');
    expect(detectPatternBlocks(mail.markdownBody, [{ kind: 'footer', start: ' ** ' }], mail.senderName)).toEqual([]);
  });

  it('the fixtures carry inline signature images for later units', async () => {
    const mail = await load('chain-owa-en.eml');
    expect(mail.markdownBody.match(/\[📎 bank-logo\.png\]/g)).toHaveLength(2);
    expect(mail.attachments.find(a => a.name === 'bank-logo.png')?.isInline).toBe(true);
  });
});

describe('detectBlocks — shared entry point for pattern and model sources', () => {
  it('tags each block with the source of its entry and resolves overlaps across sources', async () => {
    const mail = await load('chain-owa-en.eml');
    const blocks = detectBlocks(mail.markdownBody, [
      { kind: 'footer', start: 'CONFIDENTIALITY NOTICE:', end: 'Frankfurt am Main.', source: 'pattern', patternIndex: 0 },
      { kind: 'footer', start: 'If you are not the intended recipient', end: 'Frankfurt am Main.', source: 'model' },
      { kind: 'signature', start: 'Kind regards', end: 'Carol Third', source: 'model' },
    ], mail.senderName);
    // The model's footer starts inside the pattern footer in every segment and is dropped as an overlap
    expect(blocks.filter(b => b.kind === 'footer').map(b => b.source)).toEqual(['pattern', 'pattern', 'pattern', 'pattern']);
    const sig = blocks.filter(b => b.kind === 'signature');
    expect(sig).toHaveLength(1);
    expect(sig[0].source).toBe('model');
    expect(sig[0].patternIndex).toBeUndefined();
    expect(blockText(mail.markdownBody, sig[0])).toEqual(['Kind regards', 'Carol Third']);
  });
});
