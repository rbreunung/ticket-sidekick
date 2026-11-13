---
name: ts-jira
description: Runs one Jira command you type, e.g. /ts-jira load PROJ-123. /ts-jira help lists the commands.
disable-model-invocation: true
argument-hint: help|load|view|search|filters|comment|field|fields|check-fields|move|workflow|templates|upload|check|security-report|sessions <arguments>
---

The user typed after /ts-jira: `$ARGUMENTS`
(If that still shows a dollar-sign placeholder, use the text of the user's message after /ts-jira instead.)

Follow only these rules, and never invoke a skill from here. Use the first case that matches, and check cases 1 to 4 before you read the table.

1. Nothing typed: call no tool. Reply with exactly the help text below, as a code block. Stop.
2. The first word is `help`: run nothing. If the next word is `brief` or `create`, read `help-brief.md` or `help-create.md` in this skill's folder and reply with its text exactly; read no other file and call no other tool. If the next word is a command of the help text, call no tool and reply with only its line as a code block (for load and view add the "Without KEY" line). Otherwise call no tool and reply with exactly the help text. Stop.
3. The first word is not a command of the table: call no tool. Reply with exactly the help text. Stop.
4. An argument in angle brackets that the command needs is missing: call no tool. Reply with only that command's line of the help text, as a code block. Stop.
5. Otherwise make the one call the table names for the command, with the arguments typed. Do not plan, explain or add steps.

```text
Usage: /ts-jira <command> [arguments]
------------------------------------------------------------------
  help [command]              show this help, or one command's help
  load [KEY] [file ...]       load a ticket into .jira-context/
  view [KEY]                  show a ticket
  search <JQL or filter>      open the tickets in their own tab
  filters                     list your saved filters
  comment <KEY> <text>        add a comment
  field <KEY> <field> <value> update a field
  fields <KEY>                list a ticket's fields with their ids
  check-fields <KEY>          check the required fields of a ticket
  move <KEY> <status>         move a ticket
  workflow <KEY>              statuses a ticket can reach
  templates                   list the ticket templates
  upload <KEY> <path>         attach a workspace file
  check                       check the Jira connection
  security-report [PROJECT]   open the security report in its own tab
  sessions                    open the stored sessions in their own tab
------------------------------------------------------------------
Without KEY, load and view use the ticket of the git branch.
A developer brief or a guided ticket create: help brief, help create
```

| Command | Call |
| --- | --- |
| help [command] | none; see case 2 |
| load [KEY] [file ...] | `jira_load_ticket`; the files go in `attachments` |
| view [KEY] | `jira_view_ticket` |
| search <JQL or filter> | `jira_open_board` with board `ticket-list` and the text as `jql`, or as `filter` when it is a saved filter's id or name |
| filters | `jira_list_my_filters` |
| comment <KEY> <text> | `jira_add_comment` |
| field <KEY> <field> <value> | `jira_update_field` |
| fields <KEY> | `jira_list_fields` with the key as `ticketKey`; when a project key and an issue type are typed instead, as `projectKey` and `issueType` |
| check-fields <KEY> | `jira_check_required_fields` |
| move <KEY> <status> | `jira_move_ticket` |
| workflow <KEY> | `jira_workflow` |
| templates | `jira_list_templates` |
| upload <KEY> <path> | `jira_upload_attachment` |
| check | `jira_check_connection` |
| security-report [PROJECT] | `jira_open_board` with board `security-report`, and the project as `project` when one is typed |
| sessions | `jira_open_board` with board `sessions` |

For a `jira_open_board` row, reply with only the status the tool returns; never build the report or the list yourself from other tools.

After the call, show the tool's answer without adding analysis. After load, if it lists skipped attachments with numbers, show that list and ask which to download.
