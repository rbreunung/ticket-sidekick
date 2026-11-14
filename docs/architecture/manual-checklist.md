# Manual checklist

What the automated tests cannot show: Ticket Sidekick in a real VS Code with Copilot, on the maintainer's managed machine (proxy, the organisation's Copilot policies) against real Jira and Bitbucket Data Center. Each migration step adds its part here and runs it on that step's **preview** build; the one normal release at the end of the migration reruns every part. See the release rule in [`migration-status.md`](migration-status.md).

Write down the build version, the date and anything that failed under the part you ran.

## Step 1: Jira tools and boards

Preparation: a test project with a few open bugs in two fix versions, one of them with subtasks; a `.jira-templates.json` with one cleanup rule (`closeSubtasks: true`, no `resolution`) and `ticketSidekick.jira.searchFields` and `cleanupFields` each set to one field.

**Tools and skills**

- [ ] `/ts-jira check` answers with the connection, without `@jira`.
- [ ] In Agent mode, "show me PROJ-1", "add a comment to PROJ-1 saying test", "move PROJ-1 to In Progress" each run one tool; the writing tools ask first and show what they write.
- [ ] `/ts-jira workflow PROJ-1` answers; the Getting-Started step "See your ticket workflow" is checked off.
- [ ] `/ts-jira-create` creates a ticket from a template after the draft; the step "Create your first ticket" is checked off.

**Ticket list**

- [ ] "show the open bugs in PROJ" opens the ticket list in an editor tab; the chat only says it opened.
- [ ] "show my team's open bugs in sprint <name>" opens the list on the narrowed query, shown under the title.
- [ ] A list of more than 50 tickets shows 50 a page; the selection holds across pages; the `searchFields` column is there.
- [ ] A field change with **Add value** on labels keeps the other labels on every ticket.
- [ ] Apply on rows of several pages: VS Code's dialog names the count and lists every ticket.
- [ ] Change a listed ticket in Jira, close and reopen the board (or restart VS Code): the board says it is out of date and allows only paging; **Refresh** shows the change and keeps the selection.

**Cleanup**

- [ ] `/ts-jira cleanup "<rule>"`, "run the cleanup <rule>" and `Ticket Sidekick: Run a cleanup rule` open the same cleanup board.
- [ ] Subtasks show beneath their ticket; only tickets can be selected; the `cleanupFields` column is there.
- [ ] A ticket in a status without a path to the target cannot be selected and says why.
- [ ] The resolution must be chosen before Preview; Apply moves the subtasks first, then the ticket.
- [ ] Apply on page 1 changes only page 1's tickets.
- [ ] `/ts-jira cleanup "<rule>" in <version>` uses that version in place of the rule's.

**`@jira`**

- [ ] `@jira` and `@jira help` show only the imports and the notice.
- [ ] `@jira move PROJ-1 Done` answers with the notice and changes nothing.
- [ ] `@jira import veracode report`, `@jira import oss report` and `@jira create from email` still start their imports.
- [ ] Typing `@jira /` offers no slash command.

**Stable channel**

- [ ] A VS Code on the stable channel still has the current stable version with every `@jira` flow.
