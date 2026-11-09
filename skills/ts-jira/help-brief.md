/ts-jira-brief <KEY>   write a developer brief of a ticket

Use it before you start work on a ticket. It reads the ticket and all its comments, loads it and reads the attachments that matter (asking you before it downloads any the load skipped), and writes eight sections a developer can work from: problem or goal, context, steps to reproduce, acceptance criteria, decisions from comments, current state, open questions and the sources it used. Where the ticket says nothing, it writes "not stated in the ticket" instead of guessing.

Example: /ts-jira-brief PROJ-123

Without it: /ts-jira view PROJ-123 shows the whole ticket as it is, and /ts-jira load PROJ-123 puts it, with its attachments, into .jira-context/ for you to read or ask about. Quicker and cheaper when you only need the facts, not a worked-out brief.

Copilot runs /ts-jira-brief only when you type it.
