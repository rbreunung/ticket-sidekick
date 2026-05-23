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

  it('uses epoch timestamp as folder name', () => {
    expect(SCRIPT).toContain('Date.now()');
  });

  it('uses TicketSidekick/ as the downloads prefix', () => {
    expect(SCRIPT).toContain("'TicketSidekick/'");
  });
});
