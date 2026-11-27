import { describe, expect, it } from 'vitest';
import { importKind } from '../boards/import/kind';
import { reviewKind } from '../boards/review/kind';
import { securityReportKind } from '../boards/securityReport/kind';
import { ticketListKind } from '../boards/ticketList/kind';

// What a board keeps across a restart is a choice per board: a reading of Jira or a report is read
// again so it is current, and only a review, which holds work worth keeping, comes back as it was.

describe('what a board keeps across a restart', () => {
  it('is nothing for the boards that read Jira or a report: they start clean when asked for or brought back', () => {
    expect([ticketListKind, securityReportKind, importKind].map(kind => [kind.kind, kind.freshOnOpen])).toEqual([
      ['ticket-list', true], ['security-report', true], ['import', true],
    ]);
  });

  it('is the whole session for a review', () => {
    expect(reviewKind.freshOnOpen).toBeUndefined();
  });
});
