// The `prepareInvocation()` confirmation shape of the Bitbucket tools, mapping onto
// `vscode.LanguageModelToolConfirmationMessages`. vscode-free, so it stays Vitest-loadable.

/** A tool's `prepareInvocation()` confirmation — `title`/`message` map directly onto
 * `vscode.LanguageModelToolConfirmationMessages`. */
export interface ToolConfirmation {
  title: string;
  message: string;
}
