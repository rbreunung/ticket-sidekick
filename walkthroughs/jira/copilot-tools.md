Ticket Sidekick gives Copilot's agent its own Jira tools: view, find, create, comment, move, update a field, upload, load a ticket for the agent, and more. They need no extra setup beyond the Jira connection from the earlier steps.

Type `/ts-jira help` in a Copilot chat for the list of commands, for example `/ts-jira view PROJ-123` or `/ts-jira search project = PROJ AND status = Open`. You can also just ask in your own words.

Lists of tickets and the security report open as a **board** in an editor tab instead of filling the chat. A board shows a preview before it writes anything, and it comes back after a restart. Boards are also in the Command Palette: **Ticket Sidekick: Open ticket list**, **Run a cleanup rule**, **Open security report** and **Open stored sessions**.

A tool that changes Jira asks you to confirm first, showing exactly what it will write.

The `@jira` chat participant now only imports reports (emails, Veracode, Waltz), and `@bitbucket` reviews pull requests; both are deprecated, and the tools, `/ts-jira` commands and boards replace them.
