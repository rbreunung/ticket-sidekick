// Shared by both `sessionState.ts` (Jira) and `reviewSessionState.ts` (Bitbucket) — a
// prepareInvocation() confirmation always maps onto the same
// `vscode.LanguageModelToolConfirmationMessages` shape regardless of which participant's tool is
// asking. Kept in its own vscode-free, Vitest-loadable module rather than defined in one
// participant's pure-logic file and imported by the other's, so neither participant's module has
// a structural dependency on the other's (CLAUDE.md: "the two participants ... are otherwise
// fully independent").

/** A tool's `prepareInvocation()` confirmation — `title`/`message` map directly onto
 * `vscode.LanguageModelToolConfirmationMessages`. */
export interface ToolConfirmation {
  title: string;
  message: string;
}
