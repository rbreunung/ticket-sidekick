# ServiceNow → Jira: `@jira create from servicenow INC0012345`

## Context

Corporate tickets originate in ServiceNow (ITSM). When engineers need to work on them in Jira they currently re-type everything manually. The Outlook email integration was blocked by corporate IT policy (Graph API 403). ServiceNow has a well-documented Table API — no VS Code UI auth flow needed.

The feature: `@jira create from servicenow INC0012345` (or RITM/TASK/SCTASK number) fetches the ticket from ServiceNow, shows a preview (summary + description), and creates the Jira ticket on confirmation — identical UX to the email flow.

## ServiceNow Table API

Ticket prefix → table routing (handles all four supported types):

| Prefix | Table |
|--------|-------|
| `INC`    | `incident` |
| `RITM`   | `sc_req_item` |
| `TASK`   | `task` |
| `SCTASK` | `sc_task` |

Common query fields (work across all four tables):

```
GET {baseUrl}/api/now/table/{table}
  ?sysparm_query=number={number}
  &sysparm_limit=1
  &sysparm_fields=number,short_description,description,priority,state,opened_by
  &sysparm_display_value=true
```

`sysparm_display_value=true` returns human-readable strings for all fields including reference fields (priority, state, opened_by), avoiding nested `{ value, display_value }` handling.

- 401 → invalid credentials
- 404 / empty `result[]` → ticket not found

## Auth

**Basic auth only** for the POC — AD username + password, same credentials as the web UI.

```
Authorization: Basic base64(username:password)
```

Stored in SecretStorage via `ticket-sidekick.configureServiceNow` command. If the corporate instance blocks Basic auth at the REST API level, OAuth client credentials can be added later (requires IT to create an Application Registry entry in ServiceNow).

## Jira ticket built from SN ticket

```markdown
**ServiceNow:** INC0012345
**Priority:** High
**State:** New
**Reported by:** John Doe

---

{description plain text from SN, converted to markdown paragraphs}
```

Summary → `short_description`. Created in `ticketSidekick.jira.defaultProject`.

## Architecture

Follows the exact same three-layer pattern as Outlook:

```
servicenowHandler.ts → ServiceNowService → IServiceNowClient
                                                  ↓
                                       ServiceNowApiClient  (Basic auth)
                                       MockServiceNowClient (tests)
```

### Session

New lean session type in `sessionState.ts`:

```typescript
export interface ServiceNowSession {
  snTicketNumber: string;   // e.g. INC0012345, RITM1234567, TASK0099001
  subject: string;
  markdownBody: string;
  projectKey: string;
  issueType: string;
}
```

- workspaceState key: `jira.session.servicenow`
- HTML marker: `<!-- jira:servicenow -->`
- Detection order slot: after `emailContent`, before `commentList`

### Intent field

Add `snTicketNumber: string | null` to `ParsedIntent` in `llmHelpers.ts` — new field, not reusing `ticketKey`. Add `'createFromServiceNow'` to the `Operation` union.

## Implementation tasks

### Task 1 — `src/servicenow/IServiceNowClient.ts` (new)

```typescript
export interface SNTicket {
  number: string;
  shortDescription: string;
  description: string;
  priority: string;
  state: string;
  openedBy: string;
}

export interface IServiceNowClient {
  getTicket(number: string): Promise<SNTicket>;
}
```

### Task 2 — `src/servicenow/ServiceNowApiClient.ts` (new)

```typescript
const TABLE_MAP: Record<string, string> = {
  INC: 'incident',
  RITM: 'sc_req_item',
  SCTASK: 'sc_task',
  TASK: 'task',
};

function tableForNumber(number: string): string {
  const prefix = number.match(/^([A-Z]+)/)?.[1] ?? '';
  return TABLE_MAP[prefix] ?? 'task';
}
```

- Constructor: `constructor(private readonly config: { baseUrl: string; token: string })`
- Authorization header: `Basic {config.token}` (token is `base64(username:password)`)
- `getTicket(number)`:
  - detects table via `tableForNumber(number)`
  - queries with `sysparm_display_value=true`
  - 401 → "Invalid ServiceNow credentials. Run Command Palette → Ticket Sidekick: Configure ServiceNow Credentials."
  - empty result → "Ticket {number} not found in ServiceNow."
  - other errors → "ServiceNow API error {status}: {body}"

### Task 3 — `src/test/mocks/MockServiceNowClient.ts` (new)

Fixtures for `INC0012345`, `RITM1234567`, `SCTASK0099001` with known values. Throws "not found" for `INC0000000`.

### Task 4 — `src/services/ConfigService.ts`

Add:
```typescript
private static readonly SN_TOKEN_KEY = 'ticket-sidekick.servicenow.token';

getServiceNowConfig(): Promise<{ baseUrl: string; token: string | undefined }>
  // reads ticketSidekick.servicenow.baseUrl from VS Code config + token from SecretStorage

storeServiceNowToken(token: string): Promise<void>
```

### Task 5 — `src/participant/jira/llmHelpers.ts`

- Add `'createFromServiceNow'` to `Operation` union
- Add `snTicketNumber: string | null` to `ParsedIntent` interface
- Add to `INTENT_PROMPT`:
  - `createFromServiceNow`: triggered by "create from servicenow", "import SN ticket", "ticket from service-now", "SN incident"; `snTicketNumber` is the raw ticket number (INC, RITM, TASK, SCTASK prefix)

### Task 6 — `src/participant/sessionState.ts`

Add `ServiceNowSession` interface (see Architecture section above). Export alongside other session types.

### Task 7 — `src/participant/jira/servicenowHandler.ts` (new)

**`handleCreateFromServiceNow(snTicketNumber, configService, ticketService, stream, ws)`**
1. Load `getServiceNowConfig()` — if `baseUrl` missing, stream config guidance and return
2. Fetch ticket via `ServiceNowApiClient`
3. Build `markdownBody` (header block + description paragraphs)
4. Read `defaultProject` — if missing, stream guidance and return
5. Store `ServiceNowSession` in workspaceState
6. Stream preview with confirm prompt + `<!-- jira:servicenow -->`

**`handleServiceNowSession(reply, session, ticketService, stream, ws)`**
- Cancellation → clear session, stream `_Cancelled._`
- Confirmation → clear session, call `ticketService.createTicket(...)`, stream result + `<!-- @jira-ticket:KEY -->`
- Anything else → re-show preview with "Reply **post it** to create or **(c)** to cancel."

### Task 8 — `src/participant/JiraParticipant.ts`

- Import `handleCreateFromServiceNow`, `handleServiceNowSession`
- Import `ServiceNowSession`
- Add session detection after emailContent, before commentList:
  ```typescript
  const snSession = ws.get<ServiceNowSession>('jira.session.servicenow');
  if (snSession && lastResponse?.includes('<!-- jira:servicenow -->')) { ... }
  ```
- Add `createFromServiceNow` case in intent switch → call `handleCreateFromServiceNow(intent.snTicketNumber, ...)`

### Task 9 — `src/extension.ts` + `package.json`

**extension.ts**: One command:

```typescript
vscode.commands.registerCommand('ticket-sidekick.configureServiceNow', async () => {
  const username = await vscode.window.showInputBox({ prompt: 'ServiceNow username' });
  const password = await vscode.window.showInputBox({ prompt: 'ServiceNow password', password: true });
  if (username && password)
    await configService.storeServiceNowToken(Buffer.from(`${username}:${password}`).toString('base64'));
});
```

**package.json**:
- `ticketSidekick.servicenow.baseUrl` — string, "ServiceNow instance URL — standard (e.g. https://company.service-now.com) or custom domain (e.g. https://itsm.company.com). All API paths are relative to this URL."
- Command: `ticket-sidekick.configureServiceNow` → "Ticket Sidekick: Configure ServiceNow Credentials"

### Task 10 — `src/test/ServiceNowApiClient.test.ts` (new)

Cover:
- Happy path INC: all fields mapped, `Authorization: Basic …` header sent
- Happy path RITM: routes to `sc_req_item` table
- Happy path SCTASK: routes to `sc_task` table
- 401: throws with credential guidance
- Empty result: throws "not found"

### Task 11 — `README.md`

Add **Create ticket from ServiceNow** subsection under the Outlook email section in `## @jira — Jira`. Cover:
- Trigger syntax: `@jira create from servicenow INC0012345` (INC / RITM / TASK / SCTASK)
- Setup steps (baseUrl setting + configure command)
- What gets created in Jira

## Files changed

| File | Change |
|---|---|
| `src/servicenow/IServiceNowClient.ts` | NEW — `SNTicket` type + `IServiceNowClient` interface |
| `src/servicenow/ServiceNowApiClient.ts` | NEW — Basic auth, table routing by prefix |
| `src/test/mocks/MockServiceNowClient.ts` | NEW — fixtures for INC, RITM, SCTASK |
| `src/services/ConfigService.ts` | +2 methods + 1 secret key |
| `src/participant/jira/llmHelpers.ts` | +`createFromServiceNow` operation, +`snTicketNumber` field |
| `src/participant/sessionState.ts` | +`ServiceNowSession` |
| `src/participant/jira/servicenowHandler.ts` | NEW — handler functions |
| `src/participant/JiraParticipant.ts` | +session detection + intent routing |
| `src/extension.ts` | +1 command |
| `package.json` | +1 setting + 1 command |
| `src/test/ServiceNowApiClient.test.ts` | NEW — tests |
| `README.md` | +ServiceNow section |

## Verification

1. `npm test` — all existing + new tests pass
2. `npm run compile` — no TypeScript errors
3. Manual: set `ticketSidekick.servicenow.baseUrl`, run configure command, type `@jira create from servicenow INC0012345`
4. Manual: reply "post it" → Jira ticket created, key shown in chat
5. Manual: reply "(c)" → cancelled cleanly
6. Manual: RITM and SCTASK numbers → correct table queried
7. Manual: wrong number → "Ticket XYZ not found" error message
