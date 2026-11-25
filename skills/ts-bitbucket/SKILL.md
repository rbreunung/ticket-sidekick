---
name: ts-bitbucket
description: Runs one Bitbucket command you type, e.g. /ts-bitbucket review <pull request link>. /ts-bitbucket help lists the commands.
disable-model-invocation: true
argument-hint: help|review|check|usage <arguments>
---

The user typed after /ts-bitbucket: `$ARGUMENTS`
(If that still shows a dollar-sign placeholder, use the text of the user's message after /ts-bitbucket instead.)

Follow only these rules, and never invoke a skill from here. Use the first case that matches, and check cases 1 to 4 before you read the table.

1. Nothing typed: call no tool. Reply with exactly the help text below, as a code block. Stop.
2. The first word is `help`: run nothing. If the next word is `review`, read `help-review.md` in this skill's folder and reply with its text exactly; read no other file and call no other tool. If the next word is a command of the help text, call no tool and reply with only its line as a code block. Otherwise call no tool and reply with exactly the help text. Stop.
3. The first word is not a command of the table: call no tool. Reply with exactly the help text. Stop.
4. An argument in angle brackets that the command needs is missing: call no tool. Reply with only that command's line of the help text, as a code block. Stop.
5. Otherwise make the one call the table names for the command, with the arguments typed. Do not plan, explain or add steps.

```text
Usage: /ts-bitbucket <command> [arguments]
------------------------------------------------------------------
  help [command]              show this help, or one command's help
  review <url> [PROJ-123] [text]  open a pull request's review in its own tab
  check                       check the Bitbucket connection
  usage                       show the monthly token usage per model
------------------------------------------------------------------
How a review works: help review
```

| Command | Call |
| --- | --- |
| help [command] | none; see case 2 |
| review <url> [PROJ-123] [text] | `bitbucket_open_review` with the link as `url`; a Jira key the user typed as `ticketKey`; the rest of the text as `background` |
| check | `bitbucket_check_connection` |
| usage | `bitbucket_token_usage` |

For a `bitbucket_open_review` row, reply with only the status the tool returns; never review the pull request yourself from other tools.

After the call, show the tool's answer without adding analysis.
