# Salesforce ECA Credential Rotation Manager

A Visual Studio Code extension for Salesforce administrators who need to rotate **External Client App (ECA)** OAuth credentials without copying access tokens, refresh tokens, or passwords into another tool.

The extension reuses your existing Salesforce CLI authentication, discovers orgs and local External Client Apps through the Connect REST API, stages new OAuth credentials, retrieves them only after an explicit action, and guides an administrator-approved rotation with verification.

> Credential rotation invalidates the client ID and secret currently in use. Update every integration **before** approving the final rotation. The extension never rotates automatically.

> [!TIP]
> A step-by-step walkthrough with screenshots of every wizard step is published at
> **https://paoneraju.github.io/salesforce-eca-credential-rotation/**

## Features

- **Reuse Salesforce CLI auth.** Orgs come from `sf org list --json`; each operation obtains a fresh session through `sf org display --target-org <alias> --verbose --json`, resolving the token with `sf org auth show-access-token` when the CLI redacts it, and re-validates the org identity before any mutation.
- **No separate password or token storage.** The extension never writes Salesforce access tokens, refresh tokens, client secrets, or consumer secrets to settings, workspace state, logs, or the audit file.
- **Org picker.** Production, Sandbox, Scratch Org, and Dev Hub orgs are shown with CLI connection status. The extension never switches orgs silently.
- **ECA discovery.** Lists local External Client Apps with display name, API name, identifier, consumer ID, current client ID (masked), and support status. Packaged ECAs are shown but marked unsupported.
- **Guided rotation wizard.** Preflight checks, staging, retrieval, integration checklist, explicit typed-name approval, native confirmation, rotation, and post-rotation verification.
- **Secret retrieval on demand.** The staged client secret is masked until **Reveal secret** is used, re-masks automatically after 60 seconds, and is held in memory only with a configurable TTL.
- **Clipboard safety.** Copying a credential always carries a warning; the first copy in a session requires modal confirmation.
- **Secret-free audit history.** JSONL records are appended to a local audit file with a whitelist of non-sensitive fields.

## Requirements

- VS Code 1.95 or later.
- Node.js 20 or later (for development).
- Salesforce CLI (`sf`) installed and authenticated. Current CLI versions that redact tokens in `org display` are supported through `sf org auth show-access-token`.
- Salesforce API **v65.0 or later** for the selected org. The version is auto-detected or can be pinned in settings.
- The user must have permission to view and administer External Client Apps.
- To retrieve the staged client secret through the REST API, enable:

  **Setup → External Client Apps → Settings → Allow access to External Client App consumer secrets via REST API**

  Without this setting, Salesforce may stage and rotate credentials successfully but omit the `secret` field from responses. The extension reports this explicitly rather than treating a missing secret as success.

## Install

### From a packaged VSIX

```bash
code --install-extension salesforce-eca-credential-rotation-1.0.2.vsix
```

Then reload VS Code. The **Salesforce ECA Manager** view appears in the Activity Bar.

### From source

```bash
npm install
npm run compile
npm test
npm run package
```

`npm run package` creates the `.vsix` in the project root.

For an Extension Development Host, open the folder in VS Code and press **F5** (or run the **Run Extension** launch configuration).

## Usage

1. Open the **Salesforce ECA Manager** view in the Activity Bar.
2. In **Salesforce Orgs**, select **Select Salesforce Org** and choose an org. If the CLI session is expired, the extension shows a warning and offers a login command to copy.
3. Review **External Client Apps**. Select an app to see its details. Packaged apps remain visible but cannot be rotated here.
4. Start **Rotate Credentials…** from the view title, the app context menu, or the app details notification. The same wizard supports **Stage New Credentials…** and **Retrieve Staged Credentials…**.
5. In the wizard:
   - Review the preflight checks and the selected org/app.
   - Stage new credentials. Staging creates a second active credential; it does **not** invalidate the current one.
   - Retrieve the client ID and secret. Reveal the secret only when needed, copy it, and update your integrations or secret store.
   - Complete the integration update checklist.
   - Type the External Client App API name and confirm the native warning.
   - Rotate. The extension verifies the staged state and compares the active consumer key with the new client ID.
   - If the old credentials are no longer needed, delete the rotated staged credential from the result screen or with `Salesforce ECA: Delete Staged Credential...`. Deleting the record does not change the active client ID/secret.
6. Review **Rotation History**. Audit records are secret-free and can be opened directly at the relevant line.

### What "verified" means

A successful HTTP response is **not** an authentication test. The extension reports **Verified** only when Salesforce reports the staged credential as rotated **and** the org's active consumer key matches the newly retrieved client ID. It still labels the result as a state check, not a connectivity or login test.

## Commands

| Command | Purpose |
| --- | --- |
| `Salesforce ECA: Select Salesforce Org` | Choose an authenticated org explicitly. |
| `Salesforce ECA: Refresh Salesforce Orgs` | Re-read `sf org list` and reconcile the current selection. |
| `Salesforce ECA: Refresh External Client Apps` | Discover ECAs for the selected org. |
| `Salesforce ECA: Rotate Credentials...` | Open the guided rotation wizard. |
| `Salesforce ECA: Stage New Credentials...` | Stage without immediately proceeding to rotation. |
| `Salesforce ECA: Retrieve Staged Credentials...` | Retrieve and copy staged values. |
| `Salesforce ECA: Copy Staged Client ID` | Copy the held client ID with a clipboard warning. |
| `Salesforce ECA: Copy Staged Client Secret` | Copy the held client secret with a clipboard warning. |
| `Salesforce ECA: Clear Credentials From Memory` | Drop held credentials immediately. |
| `Salesforce ECA: Delete Staged Credential...` | Delete an additional staged credential without changing active credentials. |
| `Salesforce ECA: Show External Client App Details` | Show masked app/consumer details. |
| `Salesforce ECA: Open External Client Apps Setup` | Open the org's ECA Setup page. |
| `Salesforce ECA: Open Rotation Audit File` | Open the JSONL audit file. |
| `Salesforce ECA: Open Rotation Audit Record` | Reveal a specific audit record. |
| `Salesforce ECA: Open Salesforce ECA Manager Settings` | Open the extension settings. |
| `Salesforce ECA: Copy Salesforce CLI Login Command` | Copy a `sf org login web` command for the selected org. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `salesforceEca.sfCliPath` | `sf` | Path to the Salesforce CLI executable. Commands use `execFile`, never a shell. |
| `salesforceEca.apiVersion` | empty | Pin an API version such as `v66.0`. Empty means auto-detect. v65.0+ is required. |
| `salesforceEca.cliTimeoutMs` | `60000` | CLI command timeout. |
| `salesforceEca.requestTimeoutMs` | `30000` | REST request timeout. |
| `salesforceEca.credentialSessionTtlMinutes` | `10` | In-memory credential lifetime. |
| `salesforceEca.auditDirectory` | empty | Audit directory. Empty uses global extension storage. Relative paths resolve against the first workspace folder. |

## Security model

- **No secrets at rest.** Credentials live only in the extension process. `CredentialSession.toJSON()` returns `null`, and the class is never placed in `workspaceState` or `globalState`.
- **No shell command construction.** Salesforce CLI calls use `execFile` with an argument array. Org references are validated and must not start with `-` or contain control characters.
- **Always re-validate the org.** Every mutation re-runs `sf org display`, checks username, org ID, and instance URL, and calls a lightweight authenticated endpoint before proceeding.
- **No silent org switching.** If the selected org disappears or an alias resolves to another org, the operation stops with an error.
- **Allowlisted parsing.** `sf org list` output includes `accessToken` on current CLI versions; it is deliberately ignored. `sf org display --verbose` includes `sfdxAuthUrl`; it is never read. Recent CLI versions redact the access token in `org display`; the extension detects the marker and asks `sf org auth show-access-token --json` for the token without logging it.
- **Allowlisted audit fields.** Audit records contain IDs, names, timestamps, states, HTTP status codes, and outcomes—not client IDs or secrets.
- **Clipboard warning.** Every credential copy warns that other applications may read the clipboard.
- **Panels clear memory.** Closing the wizard clears held credentials.

See `SECURITY.md` for the threat model and reporting guidance.

## API contract

The extension uses documented Connect REST resources:

| Operation | Method and path |
| --- | --- |
| Discover apps | `GET /services/data/{v}/apps/oauth/usage?page=0&pageSize=100` |
| List consumers | `GET /services/data/{v}/apps/oauth/credentials/{appId}` |
| List staged credentials | `GET /services/data/{v}/apps/oauth/credentials/{appId}/{consumerId}/staged` |
| Stage credentials | `POST /services/data/{v}/apps/oauth/credentials/{appId}/{consumerId}/staged` |
| Rotate | `PATCH /services/data/{v}/apps/oauth/credentials/{appId}/{consumerId}/staged/{stagedId}` with `{"command":"rotate"}` |
| Delete staged | `DELETE /services/data/{v}/apps/oauth/credentials/{appId}/{consumerId}/staged/{stagedId}` |
| Active consumer key | `GET /services/data/{v}/apps/oauth/credentials/{appId}/{consumerId}` |

Detailed request/response handling and error mapping are in `docs/API-CONTRACT.md`.

## Troubleshooting

### "Unable to refresh session" or "expired access/refresh token"

Re-authenticate the CLI:

```bash
sf org login web --alias <alias>
```

Then run **Refresh Salesforce Orgs**. The extension never attempts to refresh or repair the CLI session on your behalf.

### HTTP 403 when discovering or rotating

Verify that the user has External Client App administrator/viewer permissions and access to consumer secrets. If secret retrieval is the failing step, enable **Allow access to External Client App consumer secrets via REST API** in Setup.

### "Salesforce did not return the staged client secret"

The REST setting above is disabled, the user lacks the "view consumer secrets" permission, or the staged credential expired. Stage new credentials after correcting the setting.

### API version unsupported

The org must advertise v65.0 or later. Leave `salesforceEca.apiVersion` empty for auto-detection or pin a supported version.

### The current CLI session is the target client

Preflight blocks rotation when the ECA consumer key matches the CLI session's OAuth client. Rotating it would invalidate the session performing the rotation. Use a different org session or client.

### Packaged apps are unsupported

Packaged External Client Apps are managed by their package and are intentionally read-only in this extension.

## Development

```bash
npm install
npm run compile     # tsc
npm run lint        # eslint with zero warnings
npm test            # compile + mocha unit tests
npm run check       # lint + test
npm run package     # vsce package --no-dependencies
```

The core services are independent of the VS Code API so they can be unit-tested with fake CLI runners and fake HTTPS transports. Tests cover CLI parsing, org identity checks, API version selection, discovery, staging, retrieval, rotation verification, audit secrecy, redaction, credential TTL, and wizard CSP.

### Project layout

```
src/core/        Salesforce CLI, REST client, ECA API, rotation, audit
src/ui/          VS Code integration: tree views, wizard, clipboard, controller
media/           Wizard CSS/JS and Activity Bar icon
src/test/        Mocha unit tests
docs/            API contract notes
```

## Limitations

- Only External Client App OAuth consumer credentials are managed. Connected Apps are not.
- Packaged ECAs are discovered but cannot be rotated.
- Rotation cannot be undone from VS Code. Salesforce may retain a rotated staged credential for a period; the extension can delete staged credentials but does not restore previous client secrets.
- Live rotation was not executed against the development orgs used while building this extension because their CLI sessions were expired. The API contract and behavior are covered by unit tests with simulated Salesforce responses; validate in a sandbox first.

## License

MIT. See `LICENSE`.
