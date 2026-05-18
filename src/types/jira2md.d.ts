declare module 'jira2md' {
  export function to_markdown(wiki: string): string;
  export function to_jira(md: string): string;
}
