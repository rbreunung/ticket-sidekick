Put it all together: point `@bitbucket` at a real pull request and get a structured, line-accurate review with severity-tagged findings.

[Ask @bitbucket to check your connection](command:workbench.action.chat.open?%5B%7B%22query%22%3A%22%40bitbucket%20check%22%7D%5D)

Once your connection checks out, type in the chat box:

`@bitbucket https://bitbucket.mycompany.com/projects/PROJ/repos/myrepo/pull-requests/42`

Optionally add a focus question after `--`:

`@bitbucket <url> -- Did I introduce any regression?`

[Ask @bitbucket to review a PR](command:workbench.action.chat.open?%5B%7B%22query%22%3A%22%40bitbucket%20%3CURL%3E%22%2C%22isPartialQuery%22%3Atrue%7D%5D)

This step completes once a review actually finishes successfully.
