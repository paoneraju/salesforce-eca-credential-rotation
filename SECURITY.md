# Security

## Scope

This extension orchestrates OAuth credential rotation for Salesforce External Client Apps (ECAs) through the Connect REST API. It is an administrative tool. A rotation invalidates the current consumer key and secret immediately; every integration using them must be updated first.

## Assets protected

- Salesforce CLI access tokens.
- Salesforce refresh tokens and `sfdxAuthUrl` values.
- ECA client IDs.
- ECA client secrets (current and staged).

## Controls

### No secret persistence

- Credentials are held in a `CredentialSession` that has no persistence layer.
- `CredentialSession.toJSON()` returns `null`. The object is never written to `workspaceState`, `globalState`, settings, or a file.
- The selected org is the only state persisted, and it contains only alias, username, org ID, instance URL, environment flags, and status.
- Retrieved credentials expire after `salesforceEca.credentialSessionTtlMinutes` (default 10).
- Closing the rotation wizard clears held credentials.
- Switching to a different org or a different ECA clears credentials that do not belong to the new scope.

### No shell injection

- Salesforce CLI calls use `execFile` with an argument array, never a shell string.
- Org references are validated: non-empty, bounded length, no leading `-`, no control characters.
- Instance URLs must be HTTPS on `*.salesforce.com`, `*.force.com`, or `*.cloudforce.com`, with no embedded credentials.
- API paths are constructed from validated identifiers and checked for `..`, backslashes, and control characters.

### Explicit identity validation

Before every mutation the extension re-runs `sf org display`, checks the username, org ID, and instance URL against the administrator's selection, and probes `/limits` with the fresh token. Current CLI versions redact the token in `org display`, so the token is read with `sf org auth show-access-token --json` and never logged. If an alias now resolves to a different org, the operation is refused. The extension never falls back to another org or the CLI default.

### Secret-free logs and audit

- The output channel receives redacted messages only. Response bodies are never logged.
- `redact()` covers key/value secrets, `Authorization: Bearer ...` headers, bare bearer tokens, Salesforce access-token shapes, SFDX auth URLs, and long opaque secrets.
- Audit records are built from a whitelist: audit ID, timestamp, action, outcome, org metadata, ECA metadata, administrator username, API version, staged credential metadata, HTTP status, verification booleans, error code/message, and notes.
- Client IDs, client secrets, access tokens, refresh tokens, and response bodies are never written to the audit file.
- The audit directory is created with mode `0700` where supported; the file is chmod `0600` where supported.

### UI protections

- The rotation webview uses a strict Content Security Policy: `default-src 'none'`, scripts only with a per-panel nonce, styles/images from the extension resource root.
- All dynamic values are delivered through `postMessage` and rendered with `textContent`/DOM APIs, not HTML interpolation.
- The secret is masked until **Reveal secret** is chosen and re-masks after 60 seconds.
- Copying a credential always warns that other applications may read the clipboard. The first credential copy in a session requires modal confirmation.
- Rotation requires a 5-item integration checklist, a typed ECA API name, and a second native confirmation.

### HTTP behavior

- HTTPS is required for every API request.
- Requests have timeouts and a maximum response size.
- Redirects are not followed by the custom transport.
- Only same-host pagination URLs under `/services/data/` are followed.

## Residual risks

- Once a secret is copied to the clipboard, other local applications may read it. Clear the clipboard after use.
- Once a secret is displayed in the webview, it exists in the extension host and webview memory until it is re-masked, the panel closes, or the TTL expires.
- Salesforce retains rotated credential metadata for a period. Deleted staged credentials may still be subject to Salesforce-side retention.
- A user with the required Salesforce permissions can rotate credentials; this extension does not add a separate authorization layer.
- Live end-to-end testing requires an org with API v65.0+, the consumer-secrets REST setting, and valid CLI authentication.

## Safe operation checklist

1. Test in a sandbox first.
2. Stage credentials and confirm the current integration still works.
3. Update named credentials, external credentials, secrets managers, CI/CD variables, middleware, and ETL jobs with the new client ID and secret.
4. Complete the checklist and rotate during a controlled window.
5. Retire the old secret only after all integrations are confirmed.

## Reporting a vulnerability

Do not include live client secrets, access tokens, refresh tokens, or `sfdxAuthUrl` values in a report. Reproduce with fictional values or a disposable sandbox. Include the extension version, VS Code version, Salesforce API version, HTTP status, and the Salesforce error code. The extension output channel and audit file are designed to be safe to share, but review them for organization-specific metadata before posting publicly.
