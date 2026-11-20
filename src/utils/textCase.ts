// Small text-case helpers shared by the boards and the session manager. Pure and vscode-free.

/** The text with its first character in upper case, e.g. "the critic" → "The critic". */
export function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
