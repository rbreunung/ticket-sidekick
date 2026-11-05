# Copilot Harness Prototype (experimental)

An experimental build of Ticket Sidekick that tries out how it could work in VS Code's newer **Copilot harness**, where `@jira` and `@bitbucket` are not available. It is only in builds made from the prototype branch; release builds don't contain it. See the main [README](../../README.md) for setup first, and [the architecture notes](../architecture/copilot-harness-migration.md) for why it exists.

## What it does

While you have it running in a VS Code window, Ticket Sidekick:

- runs a small web server inside the extension, reachable only from `127.0.0.1` and only with a random key that is new every time it starts;
- offers that server to Copilot as an MCP server named **Ticket Sidekick (prototype)**, with two tools: show a Jira ticket (also as a small inline view) and add a comment. Before a comment is added, VS Code asks you to approve the exact text;
- serves a **Ticket board** canvas that lists the unresolved tickets of your default project (`ticketSidekick.jira.defaultProject`). A comment written there is shown as a preview first and only posted when you click **Apply**.

It never starts by itself and remembers nothing. Every time VS Code starts, a notification asks whether to start it for this session; if you don't, nothing happens. Closing VS Code stops it.

## Commands

| Command | What it does |
| --- | --- |
| `Ticket Sidekick: Start prototype` | Starts the prototype for this VS Code window (the same as **Start for this session** in the notification) |
| `Ticket Sidekick: Stop prototype` | Stops it and removes what it placed outside VS Code, unless another window still runs it |
| `Ticket Sidekick: Copy prototype report` | Copies a plain-text report for testing to the clipboard. It contains no keys or tokens |
| `Ticket Sidekick: Remove prototype leftovers` | Stops the prototype and deletes its folder in the Copilot home, also after a crash |

## Requirements

- VS Code 1.144 or later, with the Copilot harness available. On older versions the commands only explain that they need a newer VS Code.
- Jira credentials and `ticketSidekick.jira.defaultProject` set, ideally to a test project, because the prototype can add comments.
- For the ticket board: the VS Code setting `chat.canvases.enabled` turned on.
- For the MCP tools: `127.0.0.1` in the VS Code setting `http.noProxy`. Without it, Copilot may send the prototype's local requests to your network proxy, which blocks them. The prototype then keeps its MCP tools off, so no such request is ever made, and says so when you start it; the ticket board works either way. Add the entry yourself: the prototype never changes your settings.

## What it places outside VS Code

While it runs, the prototype keeps one folder in the Copilot home: `~/.copilot/extensions/ticket-sidekick` (or `$COPILOT_HOME/extensions/ticket-sidekick` when `COPILOT_HOME` is set). It holds the small canvas launcher the Copilot runtime loads, and one file per running window with the server's port and canvas key; no Jira or Bitbucket token. On Linux and macOS only your user can read it. Stopping the prototype or closing VS Code deletes the folder. After a crash, run **Remove prototype leftovers**, or delete the folder by hand.

## Test protocol

1. Build the extension from the prototype branch: run `npm ci`, then `npm run package`. Install the resulting `.vsix` with **Extensions: Install from VSIX…** and reload VS Code.
2. Turn on `chat.canvases.enabled` and add `127.0.0.1` to `http.noProxy`. Check that Jira credentials and `ticketSidekick.jira.defaultProject` (a test project) are set.
3. When the notification appears, choose **Start for this session**.
4. Open a new chat, choose **Copilot** in **Session Target**, and send any first message. Run **MCP: List Servers** and check that **Ticket Sidekick (prototype)** is listed and running. Then ask: "Call the ticket_sidekick_show_ticket tool for KEY-1", using a real ticket key. The chat names each tool it calls; note whether it was `ticket_sidekick_show_ticket` (the prototype) or a `jira_…` tool (the extension's regular Agent Mode tools). Look for the small inline ticket view.
5. Ask: "Call the ticket_sidekick_add_comment tool to add 'prototype test' to KEY-1". The prototype's approval is a VS Code dialog titled "the agent wants to write to Jira". Click **Cancel** once, then ask again and approve it.
6. Open the ticket board: **Add Context (+)** → **Canvas…** → **Ticket board**. Select a ticket, write a comment, click **Preview**, then **Cancel**. Do it again and click **Apply**.
7. Open a second VS Code window on another folder, start the prototype there too, and open the ticket board from each window's chat.
8. If your organisation applies a sandbox policy to agents or MCP servers, note which one, and repeat step 4 with it in effect.
9. In each window, run **Copy prototype report** and keep both reports.
10. Run **Stop prototype**, then run **Copy prototype report** once more and keep this third report: it shows whether the last run's key is still stored anywhere. Then close VS Code, open it again and choose **Not now**.
11. Run **Remove prototype leftovers**, then check that the folder from "What it places outside VS Code" is gone.
12. Install the release build of Ticket Sidekick again. Check that the four prototype commands are gone, and that **MCP: List Servers** shows no Ticket Sidekick entry.

**What to send back:** the reports from steps 9 and 10, and for steps 4–8 and 10–12 one line each: worked or failed, plus any error text you saw. Never send a key, a token or an `Authorization` header. The report removes keys and tokens itself, but it does contain folder paths and, on Windows, the account names that may open the prototype folder; read it once before sending it on.
