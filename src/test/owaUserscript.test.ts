import { describe, it, expect } from 'vitest';
import { generateOwaUserscript } from '../utils/owaUserscript';

const SCRIPT = generateOwaUserscript({
  owaUrl: 'https://mail.contoso.com',
  vscodeUriBase: 'vscode://RobertBreunung.ticket-sidekick',
});

describe('generateOwaUserscript', () => {
  it('starts with the Tampermonkey header marker', () => {
    expect(SCRIPT.startsWith('// ==UserScript==')).toBe(true);
  });

  it('includes @match with the configured owaUrl', () => {
    expect(SCRIPT).toContain('@match        https://mail.contoso.com/*');
  });

  it('grants GM_download', () => {
    expect(SCRIPT).toContain('@grant        GM_download');
  });

  it('grants GM_xmlhttpRequest', () => {
    expect(SCRIPT).toContain('@grant        GM_xmlhttpRequest');
  });

  it('embeds the vscode URI base for navigation', () => {
    expect(SCRIPT).toContain('vscode://RobertBreunung.ticket-sidekick/from-email');
  });

  it('uses folder query parameter in the URI', () => {
    expect(SCRIPT).toContain('?folder=');
  });

  it('includes the plain capture button label', () => {
    expect(SCRIPT).toContain('📋 To Ticket');
  });

  it('includes the clean capture button label', () => {
    expect(SCRIPT).toContain('📋✨ To Ticket (Clean)');
  });

  it('uses epoch timestamp as the file name', () => {
    expect(SCRIPT).toContain('Date.now()');
  });

  it('saves a single TicketSidekick-{timestamp}.json file', () => {
    expect(SCRIPT).toContain("'TicketSidekick-' + timestamp + '.json'");
  });

  it('embeds body HTML inline instead of a separate file', () => {
    expect(SCRIPT).toContain('bodyHtml: bodyClone.innerHTML');
  });

  it('fetches images as base64 via GM_xmlhttpRequest arraybuffer', () => {
    expect(SCRIPT).toContain("responseType: 'arraybuffer'");
    expect(SCRIPT).toContain('arrayBufferToBase64');
  });

  it('injects buttons into all toolbars (querySelectorAll)', () => {
    expect(SCRIPT).toContain('querySelectorAll(\'.fui-Toolbar[role="toolbar"]\')');
  });

  it('uses id-suffix _SUBJECT selector to avoid matching navigation pane headings', () => {
    expect(SCRIPT).toContain('[id$="_SUBJECT"] span[title]');
  });

  it('uses id-suffix _ATTACHMENTS selector scoped to the attachment listbox', () => {
    expect(SCRIPT).toContain('[id$="_ATTACHMENTS"]');
    expect(SCRIPT).toContain('[role="listbox"]');
    expect(SCRIPT).toContain('[role="option"]');
  });

  it('appends attachment names to the body for inclusion in the ticket description', () => {
    expect(SCRIPT).toContain('Attachments (attach to ticket manually)');
  });

  it('escapes single quotes in vscodeUriBase to prevent script injection', () => {
    const injected = generateOwaUserscript({
      owaUrl: 'https://mail.example.com',
      vscodeUriBase: "vscode://foo'; alert(1); var x='",
    });
    expect(injected).not.toContain("'; alert(1);");
  });

  it('strips path from owaUrl so @match uses origin only', () => {
    const script = generateOwaUserscript({
      owaUrl: 'https://outlook.cloud.microsoft/mail/',
      vscodeUriBase: 'vscode://RobertBreunung.ticket-sidekick',
    });
    expect(script).toContain('@match        https://outlook.cloud.microsoft/*');
    expect(script).not.toContain('/mail/');
  });

  it('strips trailing slash from owaUrl', () => {
    const script = generateOwaUserscript({
      owaUrl: 'https://outlook.office.com/',
      vscodeUriBase: 'vscode://RobertBreunung.ticket-sidekick',
    });
    expect(script).toContain('@match        https://outlook.office.com/*');
  });

  it('handles EU date format DD.MM.YYYY HH:MM in getReceivedDateTime', () => {
    expect(SCRIPT).toContain('euMatch[3] + \'-\' + euMatch[2] + \'-\' + euMatch[1]');
  });

  it('defines MANIFEST_VERSION constant', () => {
    expect(SCRIPT).toContain('const MANIFEST_VERSION = 2');
  });

  it('embeds scriptVersion from MANIFEST_VERSION in the saved manifest', () => {
    expect(SCRIPT).toContain('scriptVersion: MANIFEST_VERSION');
  });
});
