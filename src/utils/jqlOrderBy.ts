/**
 * Splits a trailing `ORDER BY` off a query, so narrowing clauses can be ANDed onto the condition
 * while the saved ordering stays at the end, where JQL requires it. A query that only sorts has
 * an empty condition.
 */
export function splitOrderBy(jql: string): { where: string; orderBy: string } {
  // Scanned so that words inside a quoted value, such as summary ~ "slow ORDER BY query", are
  // never taken for the sort clause; a backslash escapes the next character inside quotes.
  let quote: string | undefined;
  for (let i = 0; i < jql.length; i++) {
    const ch = jql[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if ((i === 0 || /[\s)]/.test(jql[i - 1])) && /^ORDER\s+BY\s/i.test(jql.slice(i))) {
      return { where: jql.slice(0, i).trim(), orderBy: jql.slice(i).trim() };
    }
  }
  return { where: jql, orderBy: '' };
}
