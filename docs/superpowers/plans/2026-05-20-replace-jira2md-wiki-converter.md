# Plan: Replace jira2md with own Jira wiki-to-Markdown converter

## Why

`jira2md` applies italic conversion (`_` → `*`) across the entire input string, including
inside `{code}` and `{noformat}` blocks, corrupting code content (e.g. SQL column names
`id_client` → `id*client`). We currently work around this by extracting code blocks before
calling `to_markdown` and splicing them back afterwards.

Replacing the library with our own converter gives us:
- Full control over code block handling (no more workaround needed)
- First-class table and heading support (both missing from jira2md)
- One fewer runtime dependency
- Predictable behaviour we can test exhaustively

---

## Markup to support

### Block-level (processed line by line, in order)

| Jira wiki | Markdown output | Notes |
| --- | --- | --- |
| `{code:sql}…{code}` | ` ```sql\n…\n``` ` | content verbatim, no inline conversion |
| `{noformat}…{noformat}` | ` ```\n…\n``` ` | same |
| `{quote}…{quote}` | `> …` (each line prefixed) | inline conversion applied inside |
| `h1. Title` … `h6. Title` | `# Title` … `###### Title` | inline conversion applied to title text |
| `\|\|header\|\|header\|\|` + `\|cell\|cell\|` | GFM table with separator row | see Table section below |
| `* item` / `** nested` | `- item` / `  - nested` | up to 3 nesting levels |
| `# item` / `## nested` | `1. item` / `  1. nested` | same |
| `----` (four or more dashes alone on a line) | `---` | |
| blank line | blank line (paragraph separator) | |

### Inline (applied inside every non-verbatim block)

| Jira wiki | Markdown output | Notes |
| --- | --- | --- |
| `*bold*` | `**bold**` | |
| `_italic_` | `_italic_` | only when flanked by non-word chars |
| `{{mono}}` | `` `mono` `` | |
| `-strike-` | `~~strike~~` | only when flanked by non-word chars |
| `[text\|url]` | `[text](url)` | |
| `[url]` (bare) | `<url>` | |
| `[~username]` | `@username` | Jira mention |
| `{color:…}text{color}` | `text` | strip colour, keep text |
| `{panel:title=Foo}…{panel}` | `**Foo**\n…` | title as bold heading, body inline-converted |

Out of scope (no Markdown equivalent, strip tags): `+underline+`, `^super^`, `~sub~`.

### Tables

Jira table rows begin and end with `|`.  
Header rows use `||cell||` (double-pipe).

```
||Name||Value||
|foo|bar|
|baz|qux|
```

Output:

```markdown
| Name | Value |
| --- | --- |
| foo | bar |
| baz | qux |
```

Rules:
- A table is a contiguous run of lines that start with `|`.
- The first line is a header row if every delimiter is `||`; otherwise all rows are data rows with a synthetic header of empty cells.
- Cells are inline-converted.
- Trailing `|` or `||` at end of line is stripped.

---

## Implementation

### New file: `src/utils/jiraWikiToMarkdown.ts`

Single exported function:

```typescript
export function jiraWikiToMarkdown(wiki: string): string
```

Internal structure (in order of processing):

1. **Extract verbatim blocks** — scan for `{code…}…{code}` and `{noformat}…{noformat}` with a
   single regex pass. Replace each with a unique sentinel (an index into an array of fenced
   blocks). Use a sentinel string that contains no Jira wiki markup characters (e.g.
   `\x02BLOCK0\x02`). The sentinel must be safe from inline conversion.

2. **Process blocks line by line**:
   - Headings: `^h[1-6]\.\s+` → `#`…`######`
   - Horizontal rule: `^-{4,}$` → `---`
   - List lines: collect consecutive `*`/`#`-prefixed lines into a single list block
   - Table lines: collect consecutive `|`-prefixed lines into a table block
   - Quote blocks: `{quote}…{quote}` spanning multiple lines → blockquote
   - Everything else: plain paragraph text

3. **Apply inline conversions** to all non-verbatim text (headings, paragraph text, table cells,
   list items, blockquote content):
   - In a single pass with a combined regex to avoid double-conversion
   - Order matters: `{{mono}}` before `_italic_` so braces are consumed first

4. **Restore verbatim blocks** — replace sentinels with the pre-built fenced blocks.

5. **Collapse excess blank lines** — no more than two consecutive newlines.

### Modified file: `src/utils/markdownFormatter.ts`

- Remove `import { to_markdown } from 'jira2md'`
- Remove the workaround `wikiToMarkdown` function (block splitting + `to_markdown` calls)
- Export a thin `wikiToMarkdown` wrapper that calls `jiraWikiToMarkdown`
  (keeps the call sites in `formatJiraBody` unchanged)
- Remove `parseCodeLang` and `CODE_BLOCK_RE` (moved into `jiraWikiToMarkdown.ts`)

### Modified file: `package.json`

- Remove `jira2md` from `dependencies`
- Run `npm install` to update `package-lock.json`

---

## Test plan (TDD — write tests first)

Add a new describe block `wikiToMarkdown (own converter)` in
`src/test/markdownFormatter.test.ts` before touching the implementation.

| # | Test | Input | Expected output contains |
| --- | --- | --- | --- |
| 1 | SQL identifiers preserved | `{code:sql}\nid_client, id_master_client\n{code}` | `id_client`, `id_master_client` (no `*`) |
| 2 | noformat preserved | `{noformat}\nsome_var\n{noformat}` | `some_var` (no `*`) |
| 3 | h1 heading | `h1. My Heading` | `# My Heading` |
| 4 | h3 heading | `h3. Sub section` | `### Sub section` |
| 5 | Simple table | `\|\|A\|\|B\|\|\n\|1\|2\|` | `\| A \| B \|`, `\| --- \|`, `\| 1 \| 2 \|` |
| 6 | Table data-only (no header row) | `\|a\|b\|\n\|c\|d\|` | separator row present |
| 7 | Bold | `*bold*` | `**bold**` |
| 8 | Italic (word boundary) | `_italic_` | `_italic_` |
| 9 | Italic NOT applied inside code | `{code}\n_not_italic_\n{code}` | `_not_italic_` |
| 10 | Monospace | `{{mono}}` | `` `mono` `` |
| 11 | Strikethrough | `-strike-` | `~~strike~~` |
| 12 | Link with label | `[Click here\|https://example.com]` | `[Click here](https://example.com)` |
| 13 | Bare link | `[https://example.com]` | `<https://example.com>` |
| 14 | Mention | `[~jsmith]` | `@jsmith` |
| 15 | Bullet list single level | `* Alpha\n* Beta` | `- Alpha`, `- Beta` |
| 16 | Bullet list nested | `* Parent\n** Child` | `  - Child` |
| 17 | Numbered list | `# One\n# Two` | `1. One`, `2. Two` |
| 18 | Horizontal rule | `----` | `---` |
| 19 | Color stripped | `{color:red}text{color}` | `text` (no colour tags) |
| 20 | Italic outside code, not inside | `_italic_ and {code}\nnot_italic\n{code}` | italic converted, `not_italic` preserved |
| 21 | Multiple code blocks | two `{code}` blocks in one string | both preserved verbatim |
| 22 | Inline conversion in heading | `h2. Check *this* out` | `## Check **this** out` |
| 23 | Inline conversion in table cell | `\|\|Name\|\|\n\|*bold*\|` | `**bold**` inside table cell |
| 24 | Plain text passthrough | `hello world` | `hello world` |
| 25 | Empty string | `''` | `''` |

Existing tests must continue to pass unchanged — they already cover the ADF path and serve as
regression guards.

---

## Execution order

1. Write all 25 failing tests
2. Verify every new test fails for the right reason (`wikiToMarkdown` still calls old `to_markdown`)
3. Create `src/utils/jiraWikiToMarkdown.ts` — implement and iterate until all 25 pass
4. Update `markdownFormatter.ts` to call the new function (remove `jira2md` import)
5. Remove `jira2md` from `package.json`, run `npm install`
6. Run full test suite — all 300+ tests green
7. Run `npm run compile` — clean
8. Commit
