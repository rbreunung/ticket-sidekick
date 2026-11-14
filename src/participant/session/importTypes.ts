// Report-import session types the chat flow alone uses (the issue-type ask, the stepped stale close, the expired
// message). The shared review types live in src/imports/types.ts and are re-exported from here.
// Pure (vscode-free); re-exported through ../sessionState.ts.

import type {
  EmailTemplateSelectionSession, StaleTargetOption, VeracodeReviewSession, VeracodeTemplateSelectionSession,
  WaltzReviewSession, WaltzTemplateSelectionSession,
} from '../../imports/types';

export * from '../../imports/types';

// ---------------------------------------------------------------------------------------------
// Shared issue-type chat-ask (R6/KTD4) — every flow that resolves an issue type before creating a
// ticket (create; Veracode/Waltz/email report/batch import) detours through this one session type
// instead of each having its own `showInputBox`. `resume` carries the *identity* of what the user
// already picked before the detour (a project/summary, a picked template name, the rest of the
// originating session), not a pre-resolved object — each family's own continuation function
// (`continueAfterIssueType`, report import's `continueAfterImportIssueType`, reused unmodified for
// email) re-derives whatever it needs (e.g. re-looking up a template by name) once the type is
// known, exactly as it does today. See docs/jira-flows.md for the session-type table.
// ---------------------------------------------------------------------------------------------

export type AwaitIssueTypeResume =
  | {
      kind: 'create';
      projectKey: string;
      summary: string | null;
      description: string | null;
      extraFields?: Record<string, unknown>;
      pickedTemplateName: string | null;
    }
  | {
      // R1/KTD1: batch email import is a third ReportImportDescriptor kind ('email'), reusing this
      // same resume path instead of the retired standalone 'email' AwaitIssueTypeResume kind — it
      // resumes into an EmailTemplateSelectionSession exactly as 'veracode'/'waltz' already do.
      kind: 'reportImport';
      descriptorKind: 'veracode' | 'waltz' | 'email';
      pickedTemplateName: string | null;
      session: VeracodeTemplateSelectionSession | WaltzTemplateSelectionSession | EmailTemplateSelectionSession;
    };

export interface AwaitIssueTypeSession {
  resume: AwaitIssueTypeResume;
  schemaVersion: number;
}

/**
 * The stepped "close tickets" flow on the Stale screen (stale-ticket target pick plan, KTD4):
 * `pick-issue-type` (only when the selection spans several issue types, R12), then `pick-target`
 * (R1/R2), then `pick-resolution` (only when R4/KTD5 call for one). Stored under the existing
 * `jira.session.staleResolution` key with the `stale-resolution-selection` metadata kind, so the
 * participant's routing is unchanged. `reviewSession` is the review session parked while the
 * questions are open; `back` at any step returns to its Stale screen with nothing transitioned.
 */
export interface StaleCloseSession {
  descriptorKind: 'veracode' | 'waltz'; // email has no stale-check concept — never reaches this flow
  step: 'pick-issue-type' | 'pick-target' | 'pick-resolution';
  issueTypeOptions: string[];
  issueType?: string;
  targetOptions?: StaleTargetOption[];
  target?: StaleTargetOption;
  reviewSession: VeracodeReviewSession | WaltzReviewSession;
  schemaVersion: number;
}


export const SESSION_EXPIRED_MESSAGE =
  '_This import session was started before a Ticket Sidekick update and can no longer be continued — please re-run the import._';

// U6: full-ticket-key vocabulary (e.g. `PROJ-123`) for the Stale section's own toggle replies —
// deliberately disjoint from the New/Already-ticketed sections' `"1".."N"`/`"A1".."Am"` row-id
// tokens (a ticket key always contains a hyphen; a row id never does) and from U4's `next`/`prev`/
// `page <n>` page-nav tokens (none of those match this pattern either). Reuses `TICKET_KEY_TOKEN`
// (branchParser.ts's `TICKET_ID_PATTERN`, anchored) rather than a third independently-typed copy
// of the Jira ticket-key shape.
