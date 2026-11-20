import { AppError } from "../errors";
import { Logger, NoopLogger } from "../logger";
import type {
  Eca,
  EcaConsumer,
  StagedCredentialInfo,
  StagedCredentialSecret,
  StagedCredentialState
} from "../types";
import {
  SalesforceClient,
  appCredentialPath,
  consumerCredentialPath,
  oauthUsagePath,
  stagedCredentialsPath
} from "./salesforceClient";

const APP_ID_PATTERN = /^0x[A-Za-z0-9]{10,20}$/;
const CONSUMER_ID_PATTERN = /^[A-Za-z0-9]{15,20}$/;
const STAGED_ID_PATTERN = /^[A-Za-z0-9]{15,20}$/;
const MAX_PAGES = 25;

export interface EcaDiscoveryResult {
  ecas: Eca[];
  warnings: string[];
}

export interface StageResult {
  staged: StagedCredentialInfo;
  httpStatus: number;
}

export interface RotateResult {
  staged: StagedCredentialInfo;
  httpStatus: number;
}

interface RawUsageApp {
  identifier?: unknown;
  developerName?: unknown;
  description?: unknown;
  isFromPackage?: unknown;
  accessTokenFormat?: unknown;
  availableActions?: unknown;
}

interface RawUsageResponse {
  apps?: unknown;
  nextPageUrl?: unknown;
  currentPageUrl?: unknown;
}

interface RawConsumer {
  id?: unknown;
  key?: unknown;
  name?: unknown;
  url?: unknown;
  stagedCredentialsUrl?: unknown;
}

interface RawConsumersResponse {
  consumers?: unknown;
  nextPageUrl?: unknown;
}

interface RawStagedCredential {
  id?: unknown;
  state?: unknown;
  createdBy?: unknown;
  createdDate?: unknown;
  expirationDate?: unknown;
  url?: unknown;
  key?: unknown;
  secret?: unknown;
}

interface RawStagedResponse {
  stagedCredentials?: unknown;
  url?: unknown;
  id?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return undefined;
}

export function validateEcaIdentifier(identifier: string): string {
  if (!APP_ID_PATTERN.test(identifier)) {
    throw new AppError({
      code: "VALIDATION",
      userMessage: "The External Client App identifier is not valid. Refresh the app list and try again."
    });
  }
  return identifier;
}

export function validateConsumerIdentifier(consumerId: string): string {
  if (!CONSUMER_ID_PATTERN.test(consumerId)) {
    throw new AppError({
      code: "VALIDATION",
      userMessage: "The External Client App consumer identifier is not valid. Refresh the app list and try again."
    });
  }
  return consumerId;
}

export function validateStagedCredentialId(stagedId: string): string {
  if (!STAGED_ID_PATTERN.test(stagedId)) {
    throw new AppError({
      code: "VALIDATION",
      userMessage: "The staged credential identifier is not valid."
    });
  }
  return stagedId;
}

function normalizeState(value: unknown): StagedCredentialState {
  if (value === "active" || value === "rotated") {
    return value;
  }
  return "unknown";
}

/**
 * Converts a staged credential response to metadata only. The key and secret are dropped
 * before the object can escape this module, even when Salesforce includes them.
 */
function toStagedInfo(raw: RawStagedCredential): StagedCredentialInfo | undefined {
  const id = asString(raw.id);
  if (!id) {
    return undefined;
  }
  return {
    id,
    state: normalizeState(raw.state),
    createdBy: asString(raw.createdBy),
    createdDate: asString(raw.createdDate),
    expirationDate: asString(raw.expirationDate),
    url: asString(raw.url)
  };
}

function extractStagedList(data: unknown): RawStagedCredential[] {
  if (!data || typeof data !== "object") {
    return [];
  }
  const response = data as RawStagedResponse;
  if (Array.isArray(response.stagedCredentials)) {
    return response.stagedCredentials.filter(
      (entry): entry is RawStagedCredential => Boolean(entry) && typeof entry === "object"
    );
  }
  if (asString(response.id)) {
    return [response as RawStagedCredential];
  }
  return [];
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) {
        return;
      }
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export class EcaApi {
  private readonly client: SalesforceClient;
  private readonly logger: Logger;

  constructor(client: SalesforceClient, logger: Logger = new NoopLogger()) {
    this.client = client;
    this.logger = logger;
  }

  async getApiVersion(): Promise<string> {
    return this.client.getApiVersion();
  }

  async listEcas(orgAlias?: string): Promise<EcaDiscoveryResult> {
    const warnings: string[] = [];
    const apps = await this.listUsageApps(warnings);
    this.logger.info(`Discovered ${apps.length} External Client App(s) in the selected org.`);

    const ecas = await mapConcurrent(apps, 4, async (app) => {
      if (!APP_ID_PATTERN.test(app.identifier)) {
        warnings.push(`Skipped an External Client App with an invalid identifier: ${app.identifier}`);
        return [];
      }
      try {
        const consumers = await this.listConsumers(app.identifier);
        if (consumers.length === 0) {
          return [
            this.buildEca(app, undefined, orgAlias, false, "No OAuth consumer is configured for this app.")
          ];
        }
        return consumers.map((consumer) => {
          const packaged = app.isFromPackage === true;
          return this.buildEca(
            app,
            consumer,
            orgAlias,
            !packaged,
            packaged
              ? "Packaged External Client Apps are managed by their package and cannot be rotated here."
              : undefined
          );
        });
      } catch (error) {
        const reason =
          error instanceof AppError ? error.userMessage : "The credential API is not available for this app.";
        warnings.push(`${app.developerName}: ${reason}`);
        return [this.buildEca(app, undefined, orgAlias, false, reason)];
      }
    });

    return { ecas: ecas.flat(), warnings };
  }

  private buildEca(
    app: { identifier: string; developerName: string; description?: string; isFromPackage: boolean; accessTokenFormat?: string; availableActions?: string[] },
    consumer: EcaConsumer | undefined,
    orgAlias: string | undefined,
    supported: boolean,
    unsupportedReason: string | undefined
  ): Eca {
    return {
      identifier: app.identifier,
      developerName: app.developerName,
      name: consumer?.name || app.developerName,
      description: app.description,
      isFromPackage: app.isFromPackage,
      accessTokenFormat: app.accessTokenFormat,
      availableActions: app.availableActions,
      consumer,
      orgUsername: this.client.org.username,
      orgAlias,
      supported,
      unsupportedReason
    };
  }

  private async listUsageApps(warnings: string[]): Promise<
    Array<{
      identifier: string;
      developerName: string;
      description?: string;
      isFromPackage: boolean;
      accessTokenFormat?: string;
      availableActions?: string[];
    }>
  > {
    interface AppWithCursor extends RawUsageApp {
      identifier: string;
      developerName: string;
    }
    const apps: AppWithCursor[] = [];
    let suffix: string | undefined = `${oauthUsagePath()}?page=0&pageSize=100`;
    let pages = 0;
    const seen = new Set<string>();

    while (suffix && pages < MAX_PAGES) {
      if (seen.has(suffix)) {
        warnings.push("Stopped because the External Client App usage pagination repeated a page.");
        break;
      }
      seen.add(suffix);
      pages += 1;
      const response = await this.client.get<RawUsageResponse>(suffix);
      const data = response.data;
      if (!data || !Array.isArray(data.apps)) {
        warnings.push("The Salesforce OAuth usage response did not contain an apps array.");
        break;
      }
      // Salesforce can return an empty page together with a nextPageUrl. Following it
      // walks past the org's SOQL offset limit, so an empty page ends pagination.
      if (data.apps.length === 0) {
        break;
      }
      for (const entry of data.apps) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const raw = entry as RawUsageApp;
        const identifier = asString(raw.identifier);
        const developerName = asString(raw.developerName);
        if (!identifier || !developerName) {
          warnings.push("Skipped an External Client App entry without an identifier or developer name.");
          continue;
        }
        apps.push({ ...raw, identifier, developerName });
      }
      suffix = this.safePageSuffix(data.nextPageUrl, warnings);
    }
    if (pages >= MAX_PAGES && suffix) {
      warnings.push("Stopped after 25 pages of External Client App usage results.");
    }

    const deduped = new Map<string, (typeof apps)[number]>();
    for (const app of apps) {
      deduped.set(app.identifier, app);
    }
    return [...deduped.values()].map((app) => ({
      identifier: app.identifier,
      developerName: app.developerName,
      description: asString(app.description),
      isFromPackage: app.isFromPackage === true,
      accessTokenFormat: asString(app.accessTokenFormat),
      availableActions: asStringArray(app.availableActions)
    }));
  }

  private async listConsumers(appIdentifier: string): Promise<EcaConsumer[]> {
    const consumers: EcaConsumer[] = [];
    let suffix: string | undefined = appCredentialPath(appIdentifier);
    let pages = 0;
    const seen = new Set<string>();
    while (suffix && pages < MAX_PAGES) {
      if (seen.has(suffix)) {
        break;
      }
      seen.add(suffix);
      pages += 1;
      const response = await this.client.get<RawConsumersResponse>(suffix);
      const data = response.data;
      if (!data || !Array.isArray(data.consumers) || data.consumers.length === 0) {
        break;
      }
      for (const entry of data.consumers) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const raw = entry as RawConsumer;
        const id = asString(raw.id);
        if (!id) {
          continue;
        }
        consumers.push({
          id,
          key: asString(raw.key),
          name: asString(raw.name),
          url: asString(raw.url),
          stagedCredentialsUrl: asString(raw.stagedCredentialsUrl)
        });
      }
      suffix = this.safePageSuffix(data.nextPageUrl, []);
    }
    return consumers;
  }

  /**
   * Salesforce pagination URLs are absolute or root-relative and already include the
   * `/services/data/{version}` prefix. EcaApi calls the version-prefixing client, so the
   * prefix must be removed before the next request.
   */
  private safePageSuffix(nextPageUrl: unknown, warnings: string[]): string | undefined {
    const value = asString(nextPageUrl);
    if (!value) {
      return undefined;
    }
    try {
      const instance = new URL(this.client.instanceUrl);
      const url = new URL(value, instance.origin);
      if (url.protocol !== "https:" || url.hostname !== instance.hostname) {
        warnings.push("Ignored an External Client App pagination URL for a different host.");
        return undefined;
      }
      const match = /^\/services\/data\/v\d+\.\d+(\/.*)$/.exec(url.pathname);
      if (!match) {
        return undefined;
      }
      return `${match[1]}${url.search}`;
    } catch {
      warnings.push("Ignored a malformed External Client App pagination URL.");
      return undefined;
    }
  }

  async validateConsumer(appIdentifier: string, consumerId: string): Promise<EcaConsumer> {
    validateEcaIdentifier(appIdentifier);
    validateConsumerIdentifier(consumerId);
    const consumers = await this.listConsumers(appIdentifier);
    const consumer = consumers.find((entry) => entry.id === consumerId);
    if (!consumer) {
      throw new AppError({
        code: "VALIDATION",
        userMessage:
          "The selected External Client App consumer no longer exists or is not accessible. Refresh the app list and try again."
      });
    }
    return consumer;
  }

  async listStagedCredentials(
    appIdentifier: string,
    consumerId: string
  ): Promise<StagedCredentialInfo[]> {
    validateEcaIdentifier(appIdentifier);
    validateConsumerIdentifier(consumerId);
    const response = await this.client.get<RawStagedResponse>(
      stagedCredentialsPath(appIdentifier, consumerId)
    );
    const entries = extractStagedList(response.data);
    const staged = entries
      .map((entry) => toStagedInfo(entry))
      .filter((entry): entry is StagedCredentialInfo => Boolean(entry))
      .sort((left, right) => {
        const leftDate = Date.parse(left.createdDate ?? "") || 0;
        const rightDate = Date.parse(right.createdDate ?? "") || 0;
        return rightDate - leftDate;
      });
    // Microsoft Windows/Node keep the parsed JSON in scope only for this frame; no secret
    // field is ever copied into the returned metadata.
    return staged;
  }

  async stageCredentials(appIdentifier: string, consumerId: string): Promise<StageResult> {
    validateEcaIdentifier(appIdentifier);
    validateConsumerIdentifier(consumerId);
    const response = await this.client.post<RawStagedResponse>(
      stagedCredentialsPath(appIdentifier, consumerId)
    );
    const entries = extractStagedList(response.data);
    const staged = entries.map((entry) => toStagedInfo(entry)).find(Boolean);
    if (!staged) {
      throw new AppError({
        code: "VALIDATION",
        userMessage: "Salesforce did not return a staged credential. No credential was activated."
      });
    }
    this.logger.info(
      `Staged new OAuth credentials for app ${appIdentifier}, consumer ${consumerId} (state=${staged.state}).`
    );
    return { staged, httpStatus: response.status };
  }

  async retrieveStagedCredential(
    appIdentifier: string,
    consumerId: string,
    stagedCredentialId: string
  ): Promise<StagedCredentialSecret> {
    validateEcaIdentifier(appIdentifier);
    validateConsumerIdentifier(consumerId);
    validateStagedCredentialId(stagedCredentialId);
    const response = await this.client.get<RawStagedResponse>(
      stagedCredentialsPath(appIdentifier, consumerId)
    );
    const entries = extractStagedList(response.data);
    const match = entries.find((entry) => asString(entry.id) === stagedCredentialId);
    if (!match) {
      throw new AppError({
        code: "VALIDATION",
        userMessage:
          "The staged credential was not found. It may have expired, already been rotated, or been deleted. Stage new credentials again."
      });
    }
    const clientId = asString(match.key);
    const clientSecret = asString(match.secret);
    if (!clientId || !clientSecret) {
      throw new AppError({
        code: "UNSUPPORTED",
        userMessage:
          "Salesforce did not return the staged client secret. Enable Setup > External Client Apps > Settings > Allow access to External Client App consumer secrets via REST API and try again.",
        remediation:
          "The client secret is only returned when REST access to ECA consumer secrets is enabled for the org."
      });
    }
    this.logger.info(
      `Retrieved staged credential ${stagedCredentialId} for app ${appIdentifier}; values are held in memory only.`
    );
    return {
      stagedCredentialId,
      clientId,
      clientSecret,
      state: normalizeState(match.state),
      retrievedAt: new Date().toISOString(),
      expirationDate: asString(match.expirationDate)
    };
  }

  async rotateCredential(
    appIdentifier: string,
    consumerId: string,
    stagedCredentialId: string
  ): Promise<RotateResult> {
    validateEcaIdentifier(appIdentifier);
    validateConsumerIdentifier(consumerId);
    validateStagedCredentialId(stagedCredentialId);
    const response = await this.client.patch<RawStagedResponse>(
      stagedCredentialsPath(appIdentifier, consumerId, stagedCredentialId),
      { command: "rotate" }
    );
    const entries = extractStagedList(response.data);
    const staged = entries.map((entry) => toStagedInfo(entry)).find(Boolean);
    if (!staged) {
      throw new AppError({
        code: "ROTATION_FAILED",
        userMessage:
          "Salesforce accepted the rotation request but did not return a verifiable staged credential state."
      });
    }
    this.logger.info(
      `Rotation request for app ${appIdentifier}, consumer ${consumerId} returned state=${staged.state}.`
    );
    return { staged, httpStatus: response.status };
  }

  async deleteStagedCredential(
    appIdentifier: string,
    consumerId: string,
    stagedCredentialId: string
  ): Promise<number> {
    validateEcaIdentifier(appIdentifier);
    validateConsumerIdentifier(consumerId);
    validateStagedCredentialId(stagedCredentialId);
    const response = await this.client.delete<unknown>(
      stagedCredentialsPath(appIdentifier, consumerId, stagedCredentialId)
    );
    this.logger.info(`Deleted staged credential ${stagedCredentialId} for app ${appIdentifier}.`);
    return response.status;
  }

  async getActiveConsumerKey(appIdentifier: string, consumerId: string): Promise<string> {
    validateEcaIdentifier(appIdentifier);
    validateConsumerIdentifier(consumerId);
    const response = await this.client.get<RawConsumer>(consumerCredentialPath(appIdentifier, consumerId));
    const key = asString(response.data?.key);
    if (!key) {
      throw new AppError({
        code: "VALIDATION",
        userMessage: "Salesforce did not return the active consumer key for this External Client App."
      });
    }
    return key;
  }
}
