Copilot chats that run in the Copilot harness cannot use `@jira`. Ticket Sidekick offers them its Jira tools instead, through a small server that runs inside VS Code on this computer (`127.0.0.1`), protected by a key that changes at every start.

[Open the http.noProxy setting](command:workbench.action.openSettings?%22http.noProxy%22)

Add the entry `127.0.0.1` to **Http: No Proxy**. Without it, Copilot could send these local requests to your network proxy, which would block them. Ticket Sidekick never changes this setting for you, and offers the tools only while the entry is there. Enter exactly `127.0.0.1`: an entry with a port, such as `127.0.0.1:8080`, does not count, because the server's port changes at every start.

The tools appear in Copilot chats as soon as the entry is saved, without a restart. If they do not, run **Ticket Sidekick: Copy MCP diagnostics** from the Command Palette; it copies a report without keys or tokens that you can share.
