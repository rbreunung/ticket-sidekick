/ts-bitbucket review <url> [PROJ-123] [text]   open a pull request's review in its own tab

The review opens as a board in an editor tab. It starts with a regular pass over the pull request. Then you decide what happens next on the board: keep the findings as they are, run the extra passes it suggests, or pick any of them up to a full review. Each finding can be explained, drafted as a comment, posted to the pull request or copied for chat. Name a Jira ticket (PROJ-123) or add your own text, such as a goal or what to watch for, as background for the reviewer. With both, your text is picked and the ticket key stays on the board's first step, so you can switch before you press Start.

Example: /ts-bitbucket review https://bitbucket.example.com/projects/KEY/repos/repo/pull-requests/42 watch thread safety

Without it: paste the pull request link in a chat and ask for a review; Copilot opens the same board. /ts-bitbucket check tests the connection first.

Copilot runs /ts-bitbucket only when you type it.
