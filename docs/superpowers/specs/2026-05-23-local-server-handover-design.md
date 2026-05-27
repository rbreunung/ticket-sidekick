# Local Server Handover Design

**Date:** 2026-05-23  
**Status:** Draft

## Context

The Tampermonkey OWA bridge (see `2026-05-23-owa-tampermonkey-bridge-design.md`) uses `GM_download` to save a `HandoverManifest` JSON file to the Downloads folder, then fires a `vscode://` URI to trigger VS Code. This approach has three concrete problems:

1. `GM_download` does not reliably create subdirectories — files land in the root Downloads folder instead of the intended subfolder
2. Handover files mix with the user's regular Downloads
3. The injected OWA button loses its position on browser window resize

This design adds an optional local HTTP server to VS Code as the preferred delivery path (Path A), a manual `@jira load email` fallback for picking files already in Downloads (Path B), and keeps the existing `GM_download` + `vscode://` URI flow intact as Path C for environments where the server is blocked.

## Architecture

Three paths all converge on the same `readHandoverEmail()` processing function:

```
Path A — HTTP server (preferred when not blocked by corporate IT)
  Tampermonkey  ──POST /email──►  VS Code HTTP server  ──►  readHandoverEmail() in-memory

Path B — @jira load email (manual fallback)
  User types "@jira load email"
    VS Code scans handoverFolder for TicketSidekick-*.json
    Streams numbered list (subject + timestamp per file)
    User selects one
    ──────────────────────────────────────────────────►  readHandoverEmail() from file

Path C — vscode:// URI (existing, unchanged)
  Tampermonkey GM_download + vscode:// URI fires
    VS Code polls for file (up to 15 s)
    ──────────────────────────────────────────────────►  readHandoverEmail() from file
```

The generated userscript embeds the chosen path at export time. When `localServer.enabled` is true the export produces a Path A script; when false it produces the existing Path C script. Path B is always available regardless of server state.

## VS Code Settings

Two new settings added alongside the existing `ticketSidekick.email.*` group:

| Setting | Type | Default | Description |
|---|---|---|---|
| `ticketSidekick.localServer.enabled` | boolean | `false` | Start local HTTP server for direct handover (Path A) |
| `ticketSidekick.localServer.port` | number | `17385` | Port to listen on (`127.0.0.1` only) |

The existing `ticketSidekick.email.handoverFolder` covers Path B and C scan location — no change.

A shared Bearer token is generated once on first server start and stored in SecretStorage. It is embedded automatically in the exported userscript. No user-facing token configuration.

## HTTP Server (VS Code side)

### Activation

Add `onStartupFinished` to `activationEvents` in `package.json` so the extension (and server) starts with VS Code rather than waiting for a `vscode://` URI. The existing `onUri` entry stays.

Inside `activate()`, start the server only when `localServer.enabled` is true.

### Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/ping` | Bearer token | Health check |
| `POST` | `/email` | Bearer token | Receive HandoverManifest, process immediately |

**`GET /ping` response:**
```json
{ "status": "ok", "version": "0.2.1", "port": 17385 }
```

**`POST /email`:** body is `HandoverManifest` JSON (identical schema to the existing file-based format). On success: process in-memory via the existing `readHandoverEmail()` path, open chat, return `200 {"status":"received"}`. On bad token: `403`. On malformed body: `400` with a descriptive message.

Both endpoints bind to `127.0.0.1` only — never `0.0.0.0`.

### Status bar

Shows `TS ⚡ :17385` when the server is running, `TS ○` when disabled. Clicking opens the Output channel.

### Port conflict

If the configured port is already in use on startup, show an error notification:  
*"Ticket Sidekick: port 17385 is in use — change `localServer.port` in settings."*

### Output channel — "Ticket Sidekick"

Logs every request: method, path, response code, timing. On `POST /email`: logs subject and attachment count. Errors include the full message. This channel is the primary debugging surface.

### Command — "Ticket Sidekick: Test Local Server"

Fires `GET /ping` to `localhost:{port}` from within VS Code and reports:
- Success notification if reachable
- Error notification with raw error text if blocked (connection refused, timeout, etc.)

This is diagnostic step 1 — confirms the server started and is reachable from VS Code itself.

## Tampermonkey Userscript Changes

### Path A script (server mode, generated when `localServer.enabled` is true)

Replaces `GM_download` and `vscode://` URI navigation with a single `GM_xmlhttpRequest`:

```
POST http://127.0.0.1:{port}/email
Authorization: Bearer {token}
Content-Type: application/json
Body: HandoverManifest JSON
```

- On `200`: `GM_notification("Email sent to VS Code ✓")`
- On error: `GM_notification("VS Code server unreachable — is it running? Check port {port} | HTTP {status}")`

### Path C script (file mode, generated when `localServer.enabled` is false)

Unchanged from the current implementation.

### Button stability fix (both modes)

The injected OWA button is moved into a Shadow DOM host element with `position: fixed`, anchored to the bottom-right corner. Living outside OWA's React DOM tree, it survives re-renders and is unaffected by layout changes or window resize.

### New GM_registerMenuCommand (both modes)

*"Test connection to VS Code"* — fires `GM_xmlhttpRequest GET /ping`, shows result via `GM_notification`. Works independently of any open email. This is diagnostic step 2 — confirms the browser can reach the server (rules out corporate proxy/firewall interception of localhost).

## @jira load email Command (Path B)

New intent handled in `JiraParticipant` → `emailHandler.ts`.

1. Scans `ticketSidekick.email.handoverFolder` (expanded `~`) for files matching `TicketSidekick-*.json`
2. Reads `subject` and `receivedDateTime` from each file (lightweight parse)
3. Streams a numbered list to chat — most recent first; files older than 24 hours shown with a stale marker
4. User replies with a number → loads that file via `readHandoverEmail()`
5. Selection uses the existing `EmailSelectionSession` pattern
6. After processing, the selected file is deleted (same as current `deleteHandoverFile()` behaviour)

If no files are found: streams a message explaining both Path A and Path C as ways to get files there.

## Diagnostic Sequence

Recommended steps when Path A isn't working:

1. **VS Code command** *"Ticket Sidekick: Test Local Server"* — confirms server started and port is free
2. **Tampermonkey menu** → *"Test connection to VS Code"* — confirms browser can reach the server (rules out corporate firewall blocking localhost)
3. **Output channel** *"Ticket Sidekick"* — shows exact request/response detail for any delivery attempt

If step 1 passes but step 2 fails → corporate environment is intercepting localhost traffic → use Path B or Path C instead.

## Files to Create / Modify

| File | Change |
|---|---|
| `src/services/LocalServerService.ts` | New — HTTP server lifecycle, `/ping`, `/email` endpoints, token management |
| `src/extension.ts` | Start/stop `LocalServerService` on activate/deactivate; register "Test Local Server" command; add status bar item |
| `src/utils/owaUserscript.ts` | Accept `serverMode: boolean`, `port: number`, `token: string` params; generate Path A or Path C script accordingly; fix button with Shadow DOM + `position:fixed`; add GM_registerMenuCommand |
| `src/participant/jira/emailHandler.ts` | Add `handleLoadEmail()` for Path B — folder scan, list stream, selection, processing |
| `src/participant/JiraParticipant.ts` | Route `@jira load email` intent to `handleLoadEmail()` |
| `src/participant/jira/llmHelpers.ts` | Add `load-email` operation to `Operation` type and intent prompt |
| `src/services/ConfigService.ts` | Expose `localServer.enabled` and `localServer.port` settings |
| `package.json` | Add two new settings; add `onStartupFinished` to `activationEvents`; add "Test Local Server" command |
| `src/test/LocalServerService.test.ts` | New — unit tests for token validation, `/ping`, `/email` happy path and error cases |
| `src/test/owaUserscript.test.ts` | Extend — test Path A script generation (GM_xmlhttpRequest, no GM_download) |
| `README.md` | Document the three handover paths, new settings (`localServer.enabled`, `localServer.port`), `@jira load email` command, and the diagnostic sequence for corporate environments |

## Testing

1. **Unit tests:** `npm test` — `LocalServerService.test.ts` covers token auth, `/ping`, `/email` happy path, 403 on bad token, 400 on bad body
2. **Path A end-to-end:** Enable server in settings, export userscript, open OWA, click button → confirm chat opens with email preview
3. **Path B end-to-end:** Drop a `TicketSidekick-*.json` file in Downloads, type `@jira load email`, select it → confirm ticket creation flow starts
4. **Path C regression:** Disable server, export userscript, confirm `GM_download` + `vscode://` URI flow still works
5. **Corporate simulation:** Use `sudo lsof -i :{port}` and firewall rules to block the port; confirm "Test Local Server" and Tampermonkey menu command report failure clearly and that Path B still works
6. **Button stability:** Resize the OWA window — confirm the injected button stays in the bottom-right corner
