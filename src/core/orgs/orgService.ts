import { AppError, ApiError, AuthError } from "../errors";
import { Logger, NoopLogger, errorSummary } from "../logger";
import { redact } from "../redact";
import { OrgSession, type OrgConnectionStatus, type OrgEnvironment, type SalesforceOrg } from "../types";
import { SalesforceClient } from "../api/salesforceClient";
import { HttpTransport, assertSalesforceInstanceUrl } from "../api/http";
import { SfCli, type CliJsonResult } from "../cli/sfCli";

interface RawOrgRecord {
  alias?: unknown;
  username?: unknown;
  orgId?: unknown;
  id?: unknown;
  instanceUrl?: unknown;
  isDevHub?: unknown;
  isSandbox?: unknown;
  isScratch?: unknown;
  connectedStatus?: unknown;
  isDefaultUsername?: unknown;
  lastUsed?: unknown;
}

interface RawOrgListResult {
  other?: unknown;
  sandboxes?: unknown;
  nonScratchOrgs?: unknown;
  devHubs?: unknown;
  scratchOrgs?: unknown;
}

interface RawOrgListEnvelope {
  status?: unknown;
  result?: unknown;
}

export interface OrgParseResult {
  orgs: SalesforceOrg[];
  warnings: string[];
}

export interface OrgDisplayRecord {
  id: string;
  apiVersion?: string;
  accessToken?: string;
  instanceUrl: string;
  username: string;
  alias?: string;
  connectedStatus?: string;
  clientId?: string;
}

export interface OrgServiceOptions {
  cli: SfCli;
  transport: HttpTransport;
  logger?: Logger;
  timeoutMs?: number;
  configuredApiVersion?: () => string;
}

export function classifyConnectedStatus(connectedStatus: string | undefined): OrgConnectionStatus {
  if (!connectedStatus || !connectedStatus.trim()) {
    return "connected";
  }
  if (/expired|unable to refresh|refresh token|invalid_grant|session expired|invalid session/i.test(connectedStatus)) {
    return "expired";
  }
  if (/request failed|unable to connect|not found|no such org|no authorization/i.test(connectedStatus)) {
    return "unreachable";
  }
  return "connected";
}

export function resolveEnvironment(raw: RawOrgRecord, groupHints: string[]): OrgEnvironment {
  const isDevHub = raw.isDevHub === true || groupHints.includes("devHubs");
  const isSandbox = raw.isSandbox === true || groupHints.includes("sandboxes");
  const isScratch = raw.isScratch === true || groupHints.includes("scratchOrgs");
  if (isDevHub) {
    return "Dev Hub";
  }
  if (isSandbox) {
    return "Sandbox";
  }
  if (isScratch) {
    return "Scratch Org";
  }
  return "Production";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function severity(status: OrgConnectionStatus): number {
  switch (status) {
    case "expired":
      return 3;
    case "unreachable":
      return 2;
    case "unknown":
      return 1;
    default:
      return 0;
  }
}

function mergeOrg(existing: SalesforceOrg, next: SalesforceOrg): SalesforceOrg {
  const connectedStatus = next.connectedStatus ?? existing.connectedStatus;
  return {
    alias: existing.alias ?? next.alias,
    username: existing.username,
    orgId: existing.orgId ?? next.orgId,
    instanceUrl: existing.instanceUrl || next.instanceUrl,
    environment:
      existing.environment === "Dev Hub" || next.environment === "Dev Hub"
        ? "Dev Hub"
        : existing.environment === "Sandbox" || next.environment === "Sandbox"
          ? "Sandbox"
          : existing.environment === "Scratch Org" || next.environment === "Scratch Org"
            ? "Scratch Org"
            : "Production",
    isDevHub: existing.isDevHub || next.isDevHub,
    isSandbox: existing.isSandbox || next.isSandbox,
    isScratch: existing.isScratch || next.isScratch,
    connectedStatus,
    status:
      severity(next.status) > severity(existing.status) ? next.status : existing.status,
    isDefault: existing.isDefault || next.isDefault,
    lastUsed: next.lastUsed ?? existing.lastUsed
  };
}

/**
 * Parse `sf org list --json` while deliberately ignoring every non-allowlisted field.
 * In particular, current CLI versions include accessToken in this payload; it must never
 * be retained in an org object, persisted, or logged.
 */
export function parseOrgList(raw: unknown): OrgParseResult {
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { orgs: [], warnings: ["The Salesforce CLI returned an unexpected org list payload."] };
  }

  const envelope = raw as RawOrgListEnvelope;
  const result = (envelope.result ?? raw) as RawOrgListResult;
  if (!result || typeof result !== "object") {
    return { orgs: [], warnings: ["The Salesforce CLI returned no org list result."] };
  }

  const groups: Array<{ key: string; value: unknown }> = [
    { key: "devHubs", value: result.devHubs },
    { key: "sandboxes", value: result.sandboxes },
    { key: "scratchOrgs", value: result.scratchOrgs },
    { key: "nonScratchOrgs", value: result.nonScratchOrgs },
    { key: "other", value: result.other }
  ];

  const byIdentity = new Map<string, SalesforceOrg>();

  for (const group of groups) {
    if (!Array.isArray(group.value)) {
      continue;
    }
    for (const entry of group.value) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as RawOrgRecord;
      const username = asString(record.username);
      const instanceUrl = asString(record.instanceUrl);
      if (!username || !instanceUrl) {
        warnings.push("Skipped an org list entry without a username or instance URL.");
        continue;
      }
      let normalizedInstanceUrl: string;
      try {
        normalizedInstanceUrl = assertSalesforceInstanceUrl(instanceUrl);
      } catch (error) {
        warnings.push(
          `Skipped org ${username}: ${error instanceof Error ? redact(error.message) : "invalid instance URL."}`
        );
        continue;
      }

      const orgId = asString(record.orgId) ?? asString(record.id);
      const connectedStatus = asString(record.connectedStatus);
      const status = classifyConnectedStatus(connectedStatus);
      const environment = resolveEnvironment(record, [group.key]);
      const org: SalesforceOrg = {
        alias: asString(record.alias),
        username,
        orgId,
        instanceUrl: normalizedInstanceUrl,
        environment,
        isDevHub: record.isDevHub === true || group.key === "devHubs",
        isSandbox: record.isSandbox === true || group.key === "sandboxes",
        isScratch: record.isScratch === true || group.key === "scratchOrgs",
        connectedStatus,
        status,
        isDefault: record.isDefaultUsername === true,
        lastUsed: asString(record.lastUsed)
      };

      const identity = `${orgId ?? "no-org-id"}:${username.toLowerCase()}`;
      const existing = byIdentity.get(identity);
      byIdentity.set(identity, existing ? mergeOrg(existing, org) : org);
    }
  }

  const orgs = [...byIdentity.values()].sort((left, right) => {
    const leftLabel = (left.alias ?? left.username).toLowerCase();
    const rightLabel = (right.alias ?? right.username).toLowerCase();
    return leftLabel.localeCompare(rightLabel);
  });

  return { orgs, warnings };
}

/**
 * Parse `sf org display --verbose --json`. Only allowlisted fields are read. The response
 * also contains sfdxAuthUrl (a refresh token); it is intentionally never touched.
 *
 * Recent CLI versions redact accessToken in this payload and direct the caller to
 * `sf org auth show-access-token`. The token is therefore optional here; getSession()
 * resolves it through that command when the value is absent or redacted.
 */
export function parseOrgDisplay(raw: unknown): OrgDisplayRecord {
  if (!raw || typeof raw !== "object") {
    throw new AppError({
      code: "CLI_INVALID_OUTPUT",
      userMessage: "The Salesforce CLI returned an unexpected org display payload."
    });
  }
  const envelope = raw as { result?: unknown };
  const result = (envelope.result ?? raw) as Record<string, unknown>;
  const accessToken = asString(result.accessToken);
  const instanceUrl = asString(result.instanceUrl);
  const username = asString(result.username);
  if (!instanceUrl || !username) {
    throw new AuthError(
      "The Salesforce CLI did not return usable org details for the selected org. Re-authenticate and try again."
    );
  }
  let normalizedInstanceUrl: string;
  try {
    normalizedInstanceUrl = assertSalesforceInstanceUrl(instanceUrl);
  } catch (error) {
    throw new AppError({
      code: "ORG_INVALID_URL",
      userMessage: error instanceof Error ? error.message : "The org instance URL is invalid.",
      cause: error
    });
  }

  return {
    id: asString(result.id) ?? asString(result.orgId) ?? "",
    apiVersion: asString(result.apiVersion),
    accessToken: isRedactedAccessToken(accessToken) ? undefined : accessToken,
    instanceUrl: normalizedInstanceUrl,
    username,
    alias: asString(result.alias),
    connectedStatus: asString(result.connectedStatus),
    clientId: asString(result.clientId)
  };
}

export function orgReference(org: SalesforceOrg): string {
  return org.alias?.trim() || org.username;
}

/**
 * Recent Salesforce CLI versions replace the token in `org display` with a marker such as
 * "[REDACTED] See 'sf org auth show-access-token' to view". Treat an absent, marker-bearing,
 * or whitespace-containing value as unusable. Real access tokens never contain whitespace.
 */
export function isRedactedAccessToken(value: string | undefined): boolean {
  if (!value) {
    return true;
  }
  return /\bREDACTED\b|show-access-token/i.test(value) || /\s/.test(value);
}

/**
 * Parse `sf org auth show-access-token --json`. The command returns
 * `{"status":0,"result":{"accessToken":"..."}}`; plain and bare envelopes are accepted too.
 */
export function parseAccessTokenPayload(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    return raw.trim() || undefined;
  }
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const envelope = raw as { result?: unknown; accessToken?: unknown };
  const result = envelope.result;
  if (typeof result === "string") {
    return result.trim() || undefined;
  }
  if (result && typeof result === "object") {
    const token = asString((result as { accessToken?: unknown }).accessToken);
    if (token) {
      return token;
    }
  }
  return asString(envelope.accessToken);
}

export class OrgService {
  private readonly cli: SfCli;
  private readonly transport: HttpTransport;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly configuredApiVersion: () => string;

  constructor(options: OrgServiceOptions) {
    this.cli = options.cli;
    this.transport = options.transport;
    this.logger = options.logger ?? new NoopLogger();
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.configuredApiVersion = options.configuredApiVersion ?? (() => "");
  }

  async listOrgs(): Promise<OrgParseResult> {
    const result: CliJsonResult<unknown> = await this.cli.runJson<unknown>(["org", "list", "--json"]);
    const parsed = parseOrgList(result.value);
    this.logger.info(`Loaded ${parsed.orgs.length} authenticated Salesforce org(s) from the CLI.`);
    for (const warning of parsed.warnings) {
      this.logger.warn(warning);
    }
    return parsed;
  }

  /**
   * Always asks the CLI for a fresh token and verifies that the org identity is still the
   * one the administrator selected. This prevents an alias from silently pointing at a
   * different org between two steps of a rotation.
   */
  async getSession(selected: SalesforceOrg): Promise<OrgSession> {
    const reference = orgReference(selected);
    const result = await this.cli.runJson<unknown>([
      "org",
      "display",
      "--target-org",
      reference,
      "--verbose",
      "--json"
    ]);
    const display = parseOrgDisplay(result.value);

    if (display.connectedStatus && classifyConnectedStatus(display.connectedStatus) !== "connected") {
      throw new AuthError(
        `The Salesforce CLI session for ${reference} is expired or unavailable. Re-authenticate with \`sf org login web --alias ${reference}\`, then retry.`
      );
    }

    if (display.username.toLowerCase() !== selected.username.toLowerCase()) {
      throw new AppError({
        code: "ORG_MISMATCH",
        userMessage: `Refusing to continue: "${reference}" now resolves to ${display.username}, not the selected org ${selected.username}. Select the org again.`,
        remediation: "Select the intended org explicitly. The extension never switches orgs automatically."
      });
    }

    if (selected.orgId && display.id && selected.orgId !== display.id) {
      throw new AppError({
        code: "ORG_MISMATCH",
        userMessage: `Refusing to continue: the selected org ID (${selected.orgId}) does not match the CLI org ID (${display.id}) for "${reference}". Select the org again.`,
        remediation: "Select the intended org explicitly. The extension never switches orgs automatically."
      });
    }

    let displayInstanceUrl: string;
    try {
      displayInstanceUrl = assertSalesforceInstanceUrl(display.instanceUrl);
    } catch (error) {
      throw new AppError({
        code: "ORG_INVALID_URL",
        userMessage: error instanceof Error ? error.message : "The org instance URL is invalid.",
        cause: error
      });
    }
    if (displayInstanceUrl !== assertSalesforceInstanceUrl(selected.instanceUrl)) {
      throw new AppError({
        code: "ORG_MISMATCH",
        userMessage: `Refusing to continue: the instance URL for "${reference}" changed since it was selected. Select the org again.`
      });
    }

    const org: SalesforceOrg = {
      ...selected,
      alias: display.alias ?? selected.alias,
      username: display.username,
      orgId: display.id || selected.orgId,
      instanceUrl: displayInstanceUrl,
      connectedStatus: display.connectedStatus,
      status: "connected",
      environment: selected.environment
    };

    const accessToken = await this.resolveAccessToken(reference, display.accessToken);

    this.logger.info(`Validated Salesforce CLI session for ${reference} (${org.username}).`);
    return new OrgSession({
      org,
      accessToken,
      apiVersion: display.apiVersion,
      clientId: display.clientId
    });
  }

  /**
   * The CLI may return the token directly (older versions) or redact it and require
   * `sf org auth show-access-token` (current versions). The token is never logged.
   */
  private async resolveAccessToken(
    reference: string,
    displayToken: string | undefined
  ): Promise<string> {
    if (displayToken && !isRedactedAccessToken(displayToken)) {
      return displayToken;
    }

    let value: unknown;
    try {
      value = (
        await this.cli.runJson<unknown>([
          "org",
          "auth",
          "show-access-token",
          "--target-org",
          reference,
          "--json"
        ])
      ).value;
    } catch (error) {
      throw new AuthError(
        "The Salesforce CLI did not return an access token for the selected org. Update the Salesforce CLI, re-authenticate, and try again.",
        { cause: error }
      );
    }

    const token = parseAccessTokenPayload(value);
    if (!token || isRedactedAccessToken(token)) {
      throw new AuthError(
        "The Salesforce CLI did not return a usable access token for the selected org. Re-authenticate and try again."
      );
    }
    this.logger.debug(`Retrieved the access token for ${reference} through the Salesforce CLI.`);
    return token;
  }

  /**
   * Validates the token against a lightweight authenticated endpoint. A 401 means the CLI
   * token is dead. A 403 means the token is valid but the user lacks API access; that is
   * surfaced by the subsequent ECA operation with a better error message.
   */
  async assertSession(selected: SalesforceOrg): Promise<OrgSession> {
    const session = await this.getSession(selected);
    const client = new SalesforceClient(session, {
      transport: this.transport,
      logger: this.logger,
      timeoutMs: this.timeoutMs,
      configuredApiVersion: this.configuredApiVersion()
    });
    try {
      const version = await client.getApiVersion();
      await client.requestAbsolute("GET", `/services/data/${version}/limits`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        this.logger.warn(
          `The session for ${orgReference(selected)} is valid but the user lacks API access (HTTP 403).`
        );
        return session;
      }
      if (error instanceof ApiError && error.status === 401) {
        throw new AuthError(
          `The Salesforce access token for ${orgReference(selected)} was rejected. Re-authenticate with \`sf org login web --alias ${orgReference(selected)}\`, then retry.`,
          { cause: error }
        );
      }
      this.logger.warn(`Session probe failed: ${errorSummary(error)}`);
      throw error;
    }
    return session;
  }
}
