## [0.5.4] - 2026-09-03

## What's Changed
* feat(jira): generate a reusable template from a ticket
* fix(jira): never guess an issue type across all ticket-creation flows
* feat: add onboarding entry points for @jira and @bitbucket
* fix(jira): restore template generation on Data Center 11.3+ and Cloud
* fix(jira): keep onboarding and ticket creation entirely in chat
* feat(release): write CHANGELOG.md from GitHub release notes


**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.5.0...0.5.4

## [0.5.0] - 2026-08-28

## What's Changed
* docs: reorganize CLAUDE.md into a lean index plus domain docs
* fix(jira): consistent ticket-key linking and unified confirm/cancel across chat flows
* refactor(jira): unify review-table rendering behind one shared primitive
* fix(jira): guarantee Jira wiki-markup output can't carry live triggers
* feat(jira): align create-ticket template/issue-type selection into one list
* docs: capture create-list issue-type sentinel fix as a durable learning
* feat(bitbucket): diagnostic timeline for the PR review pipeline


**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.4.5...0.5.0

## [0.4.5] - 2026-08-20

## What's Changed
* Diagnostic logging expansion
* feat: import Waltz/SCA OSS vulnerability reports as Jira tickets
* refactor(jira): consolidate Veracode/Waltz report importers
* fix(waltz): unblock OSS report import on real-world .xlsx exports


**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.4.1...0.4.5

## [0.4.1] - 2026-08-12

## What's Changed
* Bitbucket PR review: upfront focus question + diff-aware follow-ups


**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.4.0...0.4.1

## [0.4.0] - 2026-08-11

## What's Changed
* docs: add AI use-case review with onboarding, reliability, and prompt suggestions
* feat: Veracode Detailed Report → Jira tickets import


**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.3.18...0.4.0

## [0.3.18] - 2026-06-10

## What's Changed
* Improve Bitbucket review follow-up: error handling, token footer, general questions, cancel


**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.3.15...0.3.18

## [0.3.15] - 2026-06-06

## What's Changed
* chore: bump to Node 24 everywhere
* fix: anchor release notes to last stable tag
* Make Bitbucket PR review line-accurate and less misleading
* fix: restore type/template selection in email-to-ticket flow; enable chat-only import


**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.3.13...0.3.15

## [0.3.13] - 2026-06-05

**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.3.12...0.3.13

## [0.3.9] - 2026-06-04

## What's Changed
* Remove URL redaction from diagnostic output
* Fix: handle missing hunks in Bitbucket DC diff response
* Improve Bitbucket large-PR review resilience


**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.3.8...0.3.9

## [0.3.8] - 2026-06-03

## What's Changed
* feat: add comment preview step, fix excessive newlines, use {noformat} for log blocks
* Translate natural-language Jira queries to JQL; add myTeamJql setting
* Add View in Jira link above every ticket list and cleanup preview


**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.3.5...0.3.8

## [0.3.5] - 2026-05-29

improve bitbucket

**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.3.4...0.3.5

## [0.3.3] - 2026-05-29

## [0.3.4] - 2026-05-29

Improvements for bulk transition

**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.3.2...0.3.4

## [0.3.2] - 2026-05-28

bugfixes to the cleanup workflows

**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.3.0...0.3.2

## [0.3.0] - 2026-05-28

improved cleanup and reviews

**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.2.10...0.3.0

## [0.2.10] - 2026-05-28

Fix Sprint handling

**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.2.8...0.2.10

## [0.2.8] - 2026-05-28

fixes and improvements

**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.2.6...0.2.8

## [0.2.6] - 2026-05-28

Fix a bug where content refinements lose their specialized LLM role, and apply the established 3-message role/ack/task prompt pattern to the five remaining bare single-turn LLM functions, add a Bitbucket Pass 2 re-evaluation note, and fill test coverage gaps for three new helpers.

**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.2.5...0.2.6

## [0.2.5] - 2026-05-27

## What's Changed
* fix: improve @jira comment/description generation quality


**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.2.4...0.2.5

## [0.2.4] - 2026-05-27

improved token usage for PR review

**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.2.3...0.2.4

## [0.2.3] - 2026-05-27

## What's Changed
* feat: EML email-to-ticket import
* feat: unified ticket creation preview


**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.2.2...0.2.3

## [0.2.2] - 2026-05-27

Import email via .eml file.

**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.2.1...0.2.2

## [0.2.1] - 2026-05-21

## What's Changed
* Add @jira load command to download full ticket context


**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.1.10...0.2.1

## [0.1.10] - 2026-05-21

## What's Changed
* feat: generalised field display and update (show fields, set any field, array ops, sprint, spell-check)


**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.1.4...0.1.10

## [0.1.4] - 2026-05-19

## What's Changed
* fix: bundle jira2md with esbuild + diagnostic check output
* feat: add "add to review" — post selected findings as Bitbucket PR comments


**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.1.3...0.1.4

## [0.1.3] - 2026-05-19

## What's Changed
* fix: include jira2md in packaged extension; fix v3 doc refs; add regression tests


**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.1.2...0.1.3

## [0.1.2] - 2026-05-19

## What's Changed
* Improve Jira workflow detection to cover all project statuses


**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.1.1...0.1.2

## [0.1.1] - 2026-05-18

- formated ticket output
- improved summary trigger

**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.1.0...0.1.1

## [0.1.0] - 2026-05-18

* PR Review works as a first draft

## What's Changed
* feat(bitbucket): register participant and commands in extension and package.json


**Full Changelog**: https://github.com/rbreunung/ticket-sidekick/compare/0.0.5...0.1.0

