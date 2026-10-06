import { describe, it, expect } from 'vitest';
import * as nodePath from 'path';
import { parseEmlFile, type EmailImportItem } from '../utils/emlParser';
import { detectPatternBlocks, type DetectedBlock } from '../utils/emailBoilerplate';
import { buildPendingEmailCleanupSession, buildEmailCleanupConsent, buildEmailCleanupPreview, parseEmailCleanupReply, applyEmailCleanupDecision, resolveSaveTarget, describeBlockKinds, type EmailCleanupSession } from '../participant/sessionState';

describe('email cleanup step — screens, replies and decisions', () => {
  const FOOTER = 'CONFIDENTIALITY NOTICE: this email is confidential.';
  const INJECTED = '[click me](command:workbench.action.chat.open?%7B%22query%22%3A%22%40jira%20delete%22%7D)';

  function emailItem(subject: string, body: string, overrides: Partial<EmailImportItem> = {}): EmailImportItem {
    return { subject, senderName: 'Alice', markdownBody: body, inlineImageMap: {}, attachments: [], emlFilePath: `/${subject}.eml`, ...overrides };
  }

  function footerBlocks(body: string): DetectedBlock[] {
    return detectPatternBlocks(body, [{ kind: 'footer', start: 'CONFIDENTIALITY NOTICE:' }]);
  }

  function batchSession(items: EmailImportItem[]): EmailCleanupSession {
    const s = buildPendingEmailCleanupSession(items, { kind: 'batch', projectKey: 'PROJ', fileName: `${items.length} selected file(s)` });
    for (const row of s.rows) row.blocks = footerBlocks(row.item.markdownBody);
    s.phase = 'preview';
    return s;
  }

  it('AE5: strip with row 3 excluded cleans emails 1, 2, 4, 5 and leaves email 3 unchanged', () => {
    const items = [1, 2, 3, 4, 5].map(i => emailItem(`Mail ${i}`, `Message ${i}\n\n${FOOTER}`));
    const session = batchSession(items);
    const toggle = parseEmailCleanupReply('3', 'preview', session.rows.map(r => r.id));
    expect(toggle).toEqual({ action: 'toggle', rowIds: ['3'] });
    session.rows[2].excluded = true;
    expect(parseEmailCleanupReply('strip', 'preview', ['1'])).toEqual({ action: 'strip' });

    const { items: out, strippedCount } = applyEmailCleanupDecision(session, 'strip');
    expect(strippedCount).toBe(4);
    expect(out.map(i => i.markdownBody)).toEqual(['Message 1', 'Message 2', `Message 3\n\n${FOOTER}`, 'Message 4', 'Message 5']);
    expect(out[2]).toBe(items[2]);
  });

  it('keep returns every original item unchanged', () => {
    const items = [emailItem('A', `Hi\n\n${FOOTER}`)];
    const { items: out, strippedCount } = applyEmailCleanupDecision(batchSession(items), 'keep');
    expect(out).toEqual(items);
    expect(strippedCount).toBe(0);
  });

  it('AE7: a stacked-footer email shows "3 footers, 1 signature" with line counts in the preview', async () => {
    const mail = await parseEmlFile(nodePath.resolve(process.cwd(), 'src/test/fixtures/eml/chain-stacked-footers.eml'));
    const session = buildPendingEmailCleanupSession([mail], { kind: 'batch', projectKey: 'PROJ', fileName: 'x.eml' });
    session.rows[0].blocks = detectPatternBlocks(mail.markdownBody, [
      { kind: 'signature', start: 'Best regards,' },
      { kind: 'footer', start: 'LEGAL NOTICE:' },
      { kind: 'footer', start: 'CONFIDENTIALITY NOTICE:' },
      { kind: 'footer', start: 'DATA PROTECTION:' },
    ], mail.senderName);
    session.phase = 'preview';
    const text = buildEmailCleanupPreview(session);
    expect(text).toContain('3 footers, 1 signature');
    expect(text).toContain('1 image(s) would be dropped');
    expect(text).toMatch(/#1 signature \(pattern\), 5 lines/);
    expect(text).toMatch(/#2 footer \(pattern\), 2 lines: “LEGAL NOTICE:/);
    expect(text).toMatch(/#4 footer \(pattern\), 1 line: “DATA PROTECTION:/);
  });

  it('a capped block shows "capped" next to its line count (AE8)', () => {
    const body = ['Hi', '', 'Best regards,', ...Array.from({ length: 45 }, (_, i) => `line ${i}`)].join('\n');
    const session = buildPendingEmailCleanupSession([emailItem('Long', body)], { kind: 'batch', projectKey: 'PROJ', fileName: 'x' });
    session.rows[0].blocks = detectPatternBlocks(body, [{ kind: 'signature', start: 'Best regards,' }]);
    expect(buildEmailCleanupPreview(session)).toContain('40 lines, capped');
  });

  it('rows with nothing detected say so, including why the model did not run', () => {
    const session = batchSession([emailItem('Plain', 'Just text'), emailItem('Other', `x\n\n${FOOTER}`)]);
    session.rows[0].modelStatus = 'declined';
    expect(buildEmailCleanupPreview(session)).toContain('**1** · Plain — nothing detected (model check skipped)');
    session.rows[0].modelStatus = 'too-long';
    expect(buildEmailCleanupPreview(session)).toContain('nothing detected (too long for model check)');
  });

  it('a command: link in the subject and in the excerpt renders inert on both the consent and preview screens', () => {
    const body = `Hello\n\nCONFIDENTIALITY NOTICE: ${INJECTED}`;
    const session = batchSession([emailItem(`Re: ${INJECTED}`, body), emailItem(`Other ${INJECTED}`, 'plain body')]);
    session.rows[1].modelStatus = 'awaiting-consent';
    const consent = buildEmailCleanupConsent(session);
    const preview = buildEmailCleanupPreview(session);
    for (const text of [consent, preview]) {
      expect(text).not.toContain('[click me](command:');
      expect(text).toContain('［click me］(command:');
    }
    expect(preview).toContain('Re: ［click me］');
  });

  it('an angle-bracket autolink in a subject or excerpt renders inert on both the consent and preview screens', () => {
    const autolink = '<command:workbench.action.chat.open?%5B%22x%22%5D>';
    const body = `Hello\n\nCONFIDENTIALITY NOTICE: <https://evil.example/x>`;
    const session = batchSession([emailItem(`Re: ${autolink}`, body), emailItem(autolink, 'plain body')]);
    session.rows[1].modelStatus = 'awaiting-consent';
    const consent = buildEmailCleanupConsent(session);
    const preview = buildEmailCleanupPreview(session);
    for (const text of [consent, preview]) {
      expect(text).not.toMatch(/(^|[^\\])<command:/);
      expect(text).toContain('\\<command:workbench.action.chat.open');
    }
    expect(preview).not.toMatch(/(^|[^\\])<https:\/\/evil/);
    expect(preview).toContain('\\<https://evil.example/x>');
  });

  it('the consent screen lists only the unmatched emails and offers model check / skip model', () => {
    const session = batchSession([emailItem('Matched', `x\n\n${FOOTER}`), emailItem('Unmatched', 'plain')]);
    session.rows[1].modelStatus = 'awaiting-consent';
    const text = buildEmailCleanupConsent(session);
    expect(text).toContain('**1** of 2 email(s) had no match');
    expect(text).toContain('**2** · Unmatched');
    expect(text).not.toContain('**1** · Matched');
    expect(decodeURIComponent(text)).toContain('"@jira model check"');
    expect(decodeURIComponent(text)).toContain('"@jira skip model"');
  });

  it('parses consent replies: model check / yes consent, skip model / no decline, cancel', () => {
    expect(parseEmailCleanupReply('model check', 'consent', [])).toEqual({ action: 'model-check' });
    expect(parseEmailCleanupReply('Yes', 'consent', [])).toEqual({ action: 'model-check' });
    expect(parseEmailCleanupReply('skip model', 'consent', [])).toEqual({ action: 'skip-model' });
    expect(parseEmailCleanupReply('no', 'consent', [])).toEqual({ action: 'skip-model' });
    expect(parseEmailCleanupReply('cancel', 'consent', [])).toEqual({ action: 'cancel' });
    expect(parseEmailCleanupReply('strip', 'consent', [])).toEqual({ action: 'invalid' });
    // A bare "check" is routed to the connection check before any session router, so it is not a consent word
    expect(parseEmailCleanupReply('check', 'consent', [])).toEqual({ action: 'invalid' });
  });

  it('parses preview replies: keep, save <n>, several row ids, unknown ids and model check are invalid', () => {
    expect(parseEmailCleanupReply('keep', 'preview', ['1'])).toEqual({ action: 'keep' });
    expect(parseEmailCleanupReply('save 2', 'preview', ['1'])).toEqual({ action: 'save', blockNumber: 2 });
    expect(parseEmailCleanupReply('save #3', 'preview', ['1'])).toEqual({ action: 'save', blockNumber: 3 });
    expect(parseEmailCleanupReply('1, 2', 'preview', ['1', '2'])).toEqual({ action: 'toggle', rowIds: ['1', '2'] });
    expect(parseEmailCleanupReply('7', 'preview', ['1', '2'])).toEqual({ action: 'invalid' });
    expect(parseEmailCleanupReply('model check', 'preview', ['1'])).toEqual({ action: 'invalid' });
    expect(parseEmailCleanupReply('cancel', 'preview', ['1'])).toEqual({ action: 'cancel' });
  });

  it('a model-found block offers save <n> with the exact phrases it would store; a pattern block does not', () => {
    const body = 'Hi\n\nThis mail and attachments are private.\nDelete it if misdirected.';
    const session = batchSession([emailItem('A', body)]);
    session.rows[0].blocks = [
      { kind: 'footer', segmentIndex: 0, startLine: 2, endLine: 3, excerpt: 'This mail and attachments are private.', nonEmptyLineCount: 2, capped: false, source: 'model' },
    ];
    const text = buildEmailCleanupPreview(session);
    expect(decodeURIComponent(text)).toContain('"@jira save 1"');
    expect(text).toContain('would store start “This mail and attachments are private.”, end “Delete it if misdirected.”');
    expect(resolveSaveTarget(session, 1)).toEqual({ ok: true, pattern: { kind: 'footer', start: 'This mail and attachments are private.', end: 'Delete it if misdirected.' } });

    const patternSession = batchSession([emailItem('B', `x\n\n${FOOTER}`)]);
    expect(buildEmailCleanupPreview(patternSession)).not.toContain('save 1');
    expect(resolveSaveTarget(patternSession, 1)).toEqual({ ok: false, reason: 'pattern-found' });
    expect(resolveSaveTarget(patternSession, 9)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('describeBlockKinds orders kinds and pluralizes', () => {
    const mk = (kind: DetectedBlock['kind']): DetectedBlock => ({ kind, segmentIndex: 0, startLine: 0, endLine: 0, excerpt: '', nonEmptyLineCount: 1, capped: false, source: 'pattern' });
    expect(describeBlockKinds([mk('signature'), mk('footer'), mk('footer'), mk('header')])).toBe('1 header, 2 footers, 1 signature');
  });
});
