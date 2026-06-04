export function tokenStatus(token: string | undefined): string {
  return token ? `present (${token.length} chars)` : '**absent**';
}
