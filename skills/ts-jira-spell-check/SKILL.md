---
name: ts-jira-spell-check
description: Checks the spelling and grammar of one Jira ticket's description, shows the corrections and writes the ones the user approves. Type /ts-jira-spell-check PROJ-123.
disable-model-invocation: true
argument-hint: <ticket key>
---

# Spell check a Jira ticket's description

Check the description of one ticket for spelling and grammar, and correct only what the user approves. The rest of the description stays as it is.

## Steps

1. Call `jira_view_ticket` for the ticket the user means. If it has no description, say so and stop.
2. Read the description and look for mistakes of spelling and grammar only. Do not reword, restyle, shorten or reorder anything, and never correct text inside code, monospace, a link target or a web address. Leave names, ticket keys, product terms and technical words alone unless they are plainly misspelled.
3. If you find nothing, say that the description has no spelling or grammar mistakes, and stop.
4. Show the corrections as a numbered list, one per line: `1. before → after`. Make each "before" the shortest piece of plain text that appears only once in the description, for example the misspelled word and the word next to it, and never across bold, italic or other formatting.
5. Wait for the user. They approve all, drop some by number (for example "skip 2"), or stop. Do not write before they answer.
6. Call `jira_correct_description` once with the ticket key and the approved corrections, in the order you showed them.
7. Show the tool's answer. If it names corrections that do not fit, show them with their reasons and offer to run again without them, or with a longer fragment.
