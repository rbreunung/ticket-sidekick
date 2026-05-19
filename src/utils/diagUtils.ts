export function redactUrls(text: string): string {
  return text.replace(/(https?:\/\/)[^\s/]+/g, '$1[redacted]');
}

export function tokenStatus(token: string | undefined): string {
  return token ? `present (${token.length} chars)` : '**absent**';
}
