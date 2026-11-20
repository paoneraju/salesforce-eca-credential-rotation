# Salesforce ECA OAuth Credential API Contract

This document records the Connect REST resources used by the extension and the assumptions the code relies on. Salesforce can change response details between releases; the extension treats every field defensively and never copies a credential value into a persisted object.

## Version and prerequisites

- Minimum API version: **v65.0**.
- Base URL: the selected org's `instanceUrl` from `sf org display`, validated as HTTPS on a Salesforce-controlled host.
- Authorization: `Authorization: Bearer <access token from the Salesforce CLI>`.
- Accept: `application/json`.
- Content-Type for JSON requests: `application/json`.

Useful permissions:

- View and manage External Client Apps.
- View External Client App consumer secrets.
- Setup → External Client Apps → Settings → **Allow access to External Client App consumer secrets via REST API** (required for the REST response to include a staged `secret`).

## Discovery

### `GET /services/data/{v}/apps/oauth/usage?page=0&pageSize=100`

Returns the apps that have OAuth usage in the org.

Representative response fields used by the extension:

```json
{
  "apps": [
    {
      "identifier": "0xI...",
      "developerName": "My_App",
      "description": "Optional description",
      "isFromPackage": false,
      "accessTokenFormat": "JWT",
      "availableActions": ["rotate"]
    }
  ],
  "nextPageUrl": "/services/data/v66.0/apps/oauth/usage?page=1&pageSize=100"
}
```

Handling:

- Pagination follows `nextPageUrl` only when it is a relative `/services/data/...` path or an HTTPS URL on the same org host.
- At most 25 pages are read.
- Entries without a valid identifier/developer name are skipped with a warning.
- Duplicate identifiers are de-duplicated.

### `GET /services/data/{v}/apps/oauth/credentials/{appId}`

Lists OAuth consumers for an app.

```json
{
  "consumers": [
    {
      "id": "C...",
      "key": "current-client-id",
      "name": "Consumer name",
      "url": "...",
      "stagedCredentialsUrl": "..."
    }
  ]
}
```

The consumer `key` is the current client ID. It is not a secret, but the UI masks it by default because it identifies the credential in use.

Apps with `isFromPackage: true` are discovered but marked unsupported; their packaged credentials are not managed here.

## Staged credentials

### `GET /services/data/{v}/apps/oauth/credentials/{appId}/{consumerId}/staged`

Returns metadata and, when permitted, credential values.

```json
{
  "stagedCredentials": [
    {
      "id": "S...",
      "state": "active",
      "createdBy": "admin@example.com",
      "createdDate": "2026-01-01T00:00:00.000Z",
      "expirationDate": "2026-01-08T00:00:00.000Z",
      "key": "new-client-id",
      "secret": "new-client-secret"
    }
  ]
}
```

Handling:

- The extension converts entries to `StagedCredentialInfo` (`id`, `state`, `createdBy`, `createdDate`, `expirationDate`, `url`) and deliberately drops `key` and `secret`.
- Recognized states: `active`, `rotated`. Anything else becomes `unknown`.
- Retrieval filters this list by staged credential ID. The `secret` may be absent. If `key` or `secret` is missing, the extension throws an actionable error and does not claim success.

### `POST /services/data/{v}/apps/oauth/credentials/{appId}/{consumerId}/staged`

Stages a new credential set. No request body is sent.

Representative response: `201 Created` with a staged credential object or a `stagedCredentials` array.

Important behavior:

- Staging adds a second credential that can authenticate. It does **not** replace or invalidate the active credential.
- If another active staged credential exists, Salesforce may replace it. The extension warns and requires explicit acknowledgment (`acknowledgeExistingStaged`).
- The POST response can include `key` and `secret`. The extension ignores them and requires a separate explicit retrieval action.

### `PATCH /services/data/{v}/apps/oauth/credentials/{appId}/{consumerId}/staged/{stagedId}`

Request body:

```json
{ "command": "rotate" }
```

This activates the staged credential and invalidates the prior consumer key/secret.

The extension:

1. Requires a confirmed approval with `confirmed`, `checklistAcknowledged`, and the typed ECA API name.
2. Requires that the administrator has already retrieved the staged credential in this session.
3. Re-validates the org and consumer.
4. Confirms the staged credential is still `active`, not already `rotated`.
5. Sends the PATCH.
6. Re-reads the staged credential list and the active consumer key.
7. Reports `verified` only when the staged state is `rotated` and the active consumer key equals the retrieved client ID. It records `authenticationTested: false` because this is a state check, not an OAuth login test.

### `DELETE /services/data/{v}/apps/oauth/credentials/{appId}/{consumerId}/staged/{stagedId}`

Deletes a staged credential. The active consumer credentials are not changed. The extension requires a native modal confirmation and clears any held credentials afterward.

### `GET /services/data/{v}/apps/oauth/credentials/{appId}/{consumerId}`

Returns the active consumer, including `key`. Used only to compare the active client ID with the newly retrieved client ID during verification.

## OAuth integration validation (optional)

For ECAs configured with the Client Credentials flow and a Run-As user:

```
POST {instanceUrl}/services/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=...&client_secret=...
```

Handling:

- Only runs after an explicit administrator confirmation.
- A success response must contain `access_token`; the token is discarded immediately and is never returned, logged, displayed, or audited.
- `invalid_client` suggests wrong credentials or a disabled flow.
- `invalid_grant` with `no client credentials user enabled` suggests a missing Run-As user.
- Timeouts and network errors are reported as inconclusive, not as credential failures.

## HTTP and error mapping

| Status | Extension behavior |
| --- | --- |
| 200/201/204 | Parse JSON if present. Empty bodies are valid for DELETE. |
| 401 | `API_AUTH` / session expired. Ask the user to re-authenticate. |
| 403 | `API_PERMISSION`. Point to ECA permissions and the consumer-secrets REST setting. |
| 404 | `API_NOT_FOUND`. Confirm the app, staged credential, and API version. |
| 409 | `API_CONFLICT`. The credential state changed; refresh and retry. |
| Other 4xx/5xx | `API_ERROR` with the Salesforce message, redacted. |
| Network failure/timeout | `API_ERROR` with a non-retryable conclusion; no success is claimed. |

Salesforce error bodies are parsed from either an array (`[{ "message", "errorCode" }]`) or an object (`{ "error", "error_description" }`).

## Version discovery

If `salesforceEca.apiVersion` is empty:

1. `GET /services/data/` returns available versions.
2. The highest version at or above v65.0 is selected.
3. If discovery fails or returns no supported version, the CLI's org `apiVersion` is considered.
4. If neither is supported, the operation stops with `API_VERSION_UNSUPPORTED`.

A configured version is normalized (`66.0` → `v66.0`) and rejected if it is below v65.0.

## Identity guarantees

Before any mutation, the extension:

- Re-runs `sf org display --target-org <alias> --verbose --json`.
- If the CLI redacts the token (`[REDACTED]` marker), runs `sf org auth show-access-token --target-org <alias> --json` and uses only the returned `accessToken`.
- Verifies the username matches the selected org.
- Verifies the org ID matches when both are known.
- Verifies the instance URL is unchanged.
- Calls `GET /services/data/{v}/limits` to confirm the token is accepted.

A 403 during this probe is treated as a valid session with insufficient API access; the actual operation then surfaces the precise permission error. A 401 is treated as an expired session.

`sf org display --verbose` also returns `sfdxAuthUrl`, which embeds a refresh token. The parser never reads or stores it. `sf org list` may return `accessToken` directly; the parser ignores all non-allowlisted fields. On current CLI versions `org display` redacts the token; the extension then calls `sf org auth show-access-token --json`, reads only `result.accessToken`, and never logs or persists it.
