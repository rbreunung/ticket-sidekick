# Documentation index

Which documents describe the product as it is, and which are history. Last reviewed 2026-11-24, after the removal of the `@jira` and `@bitbucket` chat participants. The product is **tools** (VS Code language model tools), **skills** (`/ts-jira`, `/ts-bitbucket` and four more) and **boards** (editor tabs that show a session the extension owns).

## For users

| Document | What it covers |
| --- | --- |
| [`../README.md`](../README.md) | Setup, the core commands, the Command Palette commands |
| [`manual/copilot-tools.md`](manual/copilot-tools.md) | The Jira tools and skills |
| [`manual/agent-mode-tools.md`](manual/agent-mode-tools.md) | Every tool Copilot's Agent Mode can call |
| [`manual/boards.md`](manual/boards.md) | The boards: security report, ticket list, sessions, import, review |
| [`manual/report-imports.md`](manual/report-imports.md) | Veracode, Waltz and email imports and the security report |
| [`manual/bitbucket-pr-review.md`](manual/bitbucket-pr-review.md) | Reviewing a pull request |
| [`manual/jira-templates-and-cleanup-rules.md`](manual/jira-templates-and-cleanup-rules.md) | `.jira-templates.json` |
| [`manual/settings-reference.md`](manual/settings-reference.md) | Every setting and its default |
| [`onboarding.md`](onboarding.md) | The Getting-Started walkthroughs |

## For developers: current

| Document | What it covers |
| --- | --- |
| [`../CLAUDE.md`](../CLAUDE.md) | The always-loaded index: architecture layers, key files, how to add an operation |
| [`../CONCEPTS.md`](../CONCEPTS.md) | The shared vocabulary |
| [`architecture/boards-and-sessions.md`](architecture/boards-and-sessions.md) | Design as built: sessions, boards, the write path, checklists for adding a tool, skill, board or action |
| [`architecture/migration-status.md`](architecture/migration-status.md) | What is done and open in the move from chat participants to tools and boards; the parity ledgers |
| [`architecture/manual-checklist.md`](architecture/manual-checklist.md) | What to run by hand on the managed machine before the stable release |
| [`jira-flows.md`](jira-flows.md) | Where the removed `@jira` flows went; the cleanup rules the ticket list board keeps |
| [`report-import.md`](report-import.md) | The import board and the rules of the Veracode, Waltz and email importers |
| [`review-process.md`](review-process.md) | The staged pull request review: batching, anchors, passes, critic, requirements check |
| [`../ai-usage.md`](../ai-usage.md) | Every place the extension calls a language model |
| [`known-limitations.md`](known-limitations.md) | Consciously deferred limitations, checked periodically |
| [`solutions/`](solutions/) | Solved problems, by category (reference, not superseded) |

## History (do not plan from these)

| Document | Why it is history |
| --- | --- |
| [`plans/`](plans/), [`superpowers/`](superpowers/), [`../plans/`](../plans/) | Dated plans and specs. Each describes the work as planned at its date; many name `@jira`, `@bitbucket`, the MCP server or canvases, which are removed. Read one for the reasoning behind a decision, not for how the product works now. The boards plan [`plans/2026-11-11-2234-feat-boards-replace-chat-participants-plan.md`](plans/2026-11-11-2234-feat-boards-replace-chat-participants-plan.md) holds the R-numbers the status page cites |
| [`architecture/copilot-harness-migration.md`](architecture/copilot-harness-migration.md) | The MCP, canvas and local-server routes, all removed; it still holds the rejected alternatives behind decisions D7 onward |
| [`ai-usecases-review.md`](ai-usecases-review.md) | A review of the chat participants' model calls; a banner says what still applies |
| [`bitbucket-follow-up-improvements.md`](bitbucket-follow-up-improvements.md) | Follow-up changes to the removed `@bitbucket` |
| [`issues/`](issues/), [`ideation/`](ideation/) | Point-in-time notes |
| [`presentation/intro-slides.md`](presentation/intro-slides.md) | A Marp slide deck, kept current with the product |
