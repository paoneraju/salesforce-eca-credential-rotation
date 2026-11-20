# Changelog

## 1.0.1

- Removed the optional OAuth Client Credentials validation command and its result-screen action.
- Removed the `integration-validation` audit action and `integrationValidation` audit field.
- Rotation verification remains a state check: the staged credential must report `rotated` and the active consumer key must match the retrieved client ID.
- Removed the post-rotation validation guidance from the README and SECURITY documents.

## 1.0.0

- Initial release.
- Discover authenticated Salesforce orgs through `sf org list --json`.
- Discover local External Client Apps through the Connect REST OAuth usage and credentials resources.
- Stage OAuth credentials, retrieve them on explicit administrator action, and copy them with a clipboard warning.
- Guided, administrator-approved credential rotation with API-based verification.
- Secret-free JSONL audit log for rotation attempts and outcomes.
- Supports Salesforce CLI versions that redact access tokens in `org display` by reading the token through `sf org auth show-access-token`.
- Stops External Client App pagination at empty pages to avoid the org SOQL offset limit.
- Removed the Validate new credentials action from the rotation result screen.
- Added a Delete staged credential action to the rotation result screen for cleanup after rotation.
