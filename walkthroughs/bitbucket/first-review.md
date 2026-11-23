Put it all together: open the review board for a real pull request and get a line-accurate review with severity-tagged findings.

[Check the connection](command:workbench.action.chat.open?%5B%7B%22query%22%3A%22%2Fts-bitbucket%20check%22%7D%5D)

Once your connection checks out, open the review board and paste the pull request link:

[Review a pull request](command:ticket-sidekick.boards.openReview)

Or type in a Copilot chat:

`/ts-bitbucket review https://bitbucket.mycompany.com/projects/PROJ/repos/myrepo/pull-requests/42`

The board stops on its first step: pick the review model, choose a Jira ticket, a goal or none to check against, add a question if you like, and press **Start**.

This step completes once a review actually finishes successfully.
