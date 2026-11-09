---
name: ts-jira
description: Runs one Jira command typed as /ts-jira <command> <arguments>, e.g. /ts-jira load PROJ-123. Only when the user types it.
disable-model-invocation: true
argument-hint: load|view|search|filters|comment|field|move|workflow|templates|upload|check|brief|create <arguments>
---

First check the first word the user typed after /ts-jira.

If there is no word, or it is not a command in the table below: call no tool, reply with exactly the help below and stop.

```text
/ts-jira commands:
  load [KEY] [file ...]       load a ticket into .jira-context/
  view [KEY]                  show a ticket
  search <JQL or filter>      find tickets
  filters                     list your saved filters
  comment <KEY> <text>        add a comment
  field <KEY> <field> <value> update a field
  move <KEY> <status>         move a ticket
  workflow <KEY>              statuses a ticket can reach
  templates                   list the ticket templates
  upload <KEY> <path>         attach a workspace file
  check                       check the Jira connection
  brief <KEY>                 write a developer brief
  create <request>            create a ticket with you
Without KEY, load and view use the ticket of the git branch.
```

Otherwise run that one command with one call. Do not plan, explain or add steps.

| Command | Do |
| --- | --- |
| load [KEY] [file ...] | call `jira_load_ticket`; files go in `attachments` |
| view [KEY] | call `jira_view_ticket` |
| search <JQL or filter name> | call `jira_find_tickets` |
| filters | call `jira_list_my_filters` |
| comment <KEY> <text> | call `jira_add_comment` |
| field <KEY> <field> <value> | call `jira_update_field` |
| move <KEY> <status> | call `jira_move_ticket` |
| workflow <KEY> | call `jira_workflow` |
| templates | call `jira_list_templates` |
| upload <KEY> <path> | call `jira_upload_attachment` |
| check | call `jira_check_connection` |
| brief <KEY> | follow the `jira-brief` skill |
| create <request> | follow the `jira-create` skill |

Afterwards give the tool's answer briefly. After load, show its numbered list of skipped attachments and ask which to download.
