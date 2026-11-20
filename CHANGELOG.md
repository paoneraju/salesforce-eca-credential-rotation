# Changelog

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
