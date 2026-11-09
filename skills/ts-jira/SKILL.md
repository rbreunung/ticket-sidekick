---
name: ts-jira
description: Runs one Jira command typed as /ts-jira <command> <arguments>, e.g. /ts-jira load PROJ-123. Only when the user types it.
disable-model-invocation: true
argument-hint: help|load|view|search|filters|comment|field|move|workflow|templates|upload|check|brief|create <arguments>
---

Take what the user typed after /ts-jira and use the first case that matches. Do not read ahead to the table before you have checked cases 1 to 3.

1. Nothing typed: call no tool. Reply with exactly the help text below. Stop.
2. The first word is `help`: call no tool, open no other skill, run nothing. If the next word is a command of the help text, reply with only its line (for load and view also the last line). Otherwise reply with exactly the help text. Stop.
3. The first word is not a command of the table: call no tool. Reply with exactly the help text. Stop.
4. Otherwise run that one command with one call, as the table says. Do not plan, explain or add steps.

```text
/ts-jira commands:
  help [command]              show this help, or one command's help
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


| Command | Do |
| --- | --- |
| help [command] | show the help; call no tool |
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
