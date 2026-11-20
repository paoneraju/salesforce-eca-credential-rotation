import { AppError, ApiError } from "../errors";
import { Logger, NoopLogger, errorSummary } from "../logger";
import { redact } from "../redact";
import type { OrgSession } from "../types";
import {
  pickUsableVersion,
  normalizeApiVersion,
  MIN_API_VERSION_MAJOR,
  isSupportedApiVersion
} from "./apiVersion";
import { HttpTransport, TransportError, assertSalesforceInstanceUrl } from "./http";

export interface ApiResponse<T> {
  status: number;
  data: T;
  headers: Record<string, string | string[] | undefined>;
}

export interface SalesforceClientOptions {
  transport: HttpTransport;
  logger?: Logger;
  timeoutMs?: number;
  configuredApiVersion?: string;
}

interface ParsedApiError {
  message: string;
  code?: string;
}

function parseJsonSafe(body: string): unknown {
  if (!body.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export function parseSalesforceError(body: string): ParsedApiError {
  const parsed = parseJsonSafe(body);
  if (Array.isArray(parsed) && parsed.length > 0) {
    const first = parsed[0] as Record<string, unknown>;
    return {
      message: typeof first.message === "string" ? first.message : "Unknown Salesforce error.",
      code: typeof first.errorCode === "string" ? first.errorCode : undefined
    };
  }
  if (parsed && typeof parsed === "object") {
    const object = parsed as Record<string, unknown>;
    const message =
      (typeof object.message === "string" && object.message) ||
      (typeof object.error_description === "string" && object.error_description) ||
      (typeof object.error === "string" && object.error) ||
      "Unknown Salesforce error.";
    const code =
      (typeof object.errorCode === "string" && object.errorCode) ||
      (typeof object.error === "string" && object.error) ||
      undefined;
    return { message, code };
  }
  const trimmed = body.trim();
  if (trimmed && trimmed.length <= 500 && !trimmed.startsWith("<")) {
    return { message: trimmed };
  }
  return { message: "Salesforce returned an error response." };
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function assertApiPath(path: string): void {
  if (!path.startsWith("/") || path.includes("..") || path.includes("\\")) {
    throw new AppError({
      code: "INTERNAL",
      userMessage: "Refusing to construct an unsafe Salesforce API path."
    });
  }
  // eslint-disable-next-line no-control-regex -- control characters must be rejected in API paths.
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw new AppError({
      code: "INTERNAL",
      userMessage: "Refusing to construct an unsafe Salesforce API path."
    });
  }
}

export class SalesforceClient {
  private readonly session: OrgSession;
  private readonly transport: HttpTransport;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly configuredApiVersion?: string;
  private versionPromise?: Promise<string>;

  constructor(session: OrgSession, options: SalesforceClientOptions) {
    this.session = session;
    this.transport = options.transport;
    this.logger = options.logger ?? new NoopLogger();
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.configuredApiVersion = options.configuredApiVersion;
  }

  get org(): OrgSession["org"] {
    return this.session.org;
  }

  get instanceUrl(): string {
    return assertSalesforceInstanceUrl(this.session.org.instanceUrl);
  }

  async getApiVersion(): Promise<string> {
    if (!this.versionPromise) {
      this.versionPromise = this.resolveApiVersion().catch((error) => {
        this.versionPromise = undefined;
        throw error;
      });
    }
    return this.versionPromise;
  }

  async get<T>(suffix: string): Promise<ApiResponse<T>> {
    return this.requestApi<T>("GET", suffix);
  }

  async post<T>(suffix: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.requestApi<T>("POST", suffix, body);
  }

  async patch<T>(suffix: string, body: unknown): Promise<ApiResponse<T>> {
    return this.requestApi<T>("PATCH", suffix, body);
  }

  async delete<T>(suffix: string): Promise<ApiResponse<T>> {
    return this.requestApi<T>("DELETE", suffix);
  }

  async requestApi<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    suffix: string,
    body?: unknown
  ): Promise<ApiResponse<T>> {
    if (!suffix.startsWith("/")) {
      throw new AppError({
        code: "INTERNAL",
        userMessage: "Salesforce API suffixes must start with a slash."
      });
    }
    const version = await this.getApiVersion();
    const path = `/services/data/${version}${suffix}`;
    return this.requestAbsolute<T>(method, path, body);
  }

  async requestAbsolute<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<ApiResponse<T>> {
    assertApiPath(path);
    const url = `${this.instanceUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.session.accessToken}`,
      Accept: "application/json"
    };

    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }

    this.logger.debug(`Salesforce ${method} ${path}`);

    let response;
    try {
      response = await this.transport.request({
        url,
        method,
        headers,
        body: payload,
        timeoutMs: this.timeoutMs
      });
    } catch (error) {
      if (error instanceof TransportError) {
        const timedOut = error.code === "TIMEOUT";
        throw new AppError({
          code: "API_ERROR",
          userMessage: timedOut
            ? "The Salesforce request timed out. The org may be unavailable or the network may be slow."
            : "Could not reach Salesforce. Check your network connection and the org instance URL.",
          cause: error,
          details: errorSummary(error)
        });
      }
      throw new AppError({
        code: "API_ERROR",
        userMessage: "Could not reach Salesforce.",
        cause: error,
        details: errorSummary(error)
      });
    }

    this.logger.debug(`Salesforce ${method} ${path} -> HTTP ${response.status}`);

    if (response.status >= 200 && response.status < 300) {
      const data = parseJsonSafe(response.body) as T;
      return { status: response.status, data, headers: response.headers };
    }

    const parsed = parseSalesforceError(response.body);
    const requestId =
      headerValue(response.headers, "sfdc-request-id") ??
      headerValue(response.headers, "x-request-id") ??
      headerValue(response.headers, "x-sfdc-request-id");

    if (response.status === 401) {
      throw new ApiError({
        status: 401,
        message: "Salesforce rejected the session as expired or invalid.",
        salesforceCode: parsed.code,
        requestId,
        details: redact(parsed.message)
      });
    }

    const prefix =
      response.status === 403
        ? "Salesforce denied access to this External Client App operation."
        : response.status === 404
          ? "Salesforce could not find the requested External Client App resource."
          : response.status === 409
            ? "Salesforce reported a conflict for this credential operation."
            : "Salesforce rejected the request.";

    throw new ApiError({
      status: response.status,
      message: `${prefix} ${redact(parsed.message)}`,
      salesforceCode: parsed.code,
      requestId,
      details: parsed.code ? `Salesforce error code: ${redact(parsed.code)}` : undefined
    });
  }

  private async resolveApiVersion(): Promise<string> {
    if (this.configuredApiVersion && this.configuredApiVersion.trim()) {
      const normalized = normalizeApiVersion(this.configuredApiVersion);
      if (!normalized) {
        throw new AppError({
          code: "API_VERSION_UNSUPPORTED",
          userMessage: `Invalid Salesforce API version setting "${this.configuredApiVersion}".`
        });
      }
      if (!isSupportedApiVersion(normalized)) {
        throw new AppError({
          code: "API_VERSION_UNSUPPORTED",
          userMessage: `API version ${normalized} is not supported. Credential rotation requires v${MIN_API_VERSION_MAJOR}.0 or later.`
        });
      }
      return normalized;
    }

    let discovered: string[] = [];
    try {
      const response = await this.requestAbsolute<Array<{ version?: unknown }>>("GET", "/services/data/");
      if (Array.isArray(response.data)) {
        discovered = response.data
          .map((entry) => (typeof entry.version === "string" ? entry.version : undefined))
          .filter((version): version is string => Boolean(version));
      }
    } catch (error) {
      this.logger.warn(`Could not discover org API versions: ${errorSummary(error)}`);
    }

    try {
      const chosen = pickUsableVersion({
        configured: this.configuredApiVersion,
        discovered,
        orgApiVersion: this.session.apiVersion
      });
      this.logger.debug(`Using Salesforce API version ${chosen.version} (${chosen.source}).`);
      return chosen.version;
    } catch (error) {
      throw new AppError({
        code: "API_VERSION_UNSUPPORTED",
        userMessage:
          error instanceof Error
            ? error.message
            : `The selected org does not support the required API version (v${MIN_API_VERSION_MAJOR}.0+).`,
        cause: error
      });
    }
  }
}

function encodeSegments(segments: string[]): string {
  return `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

export function appCredentialPath(appIdentifier: string): string {
  return encodeSegments(["apps", "oauth", "credentials", appIdentifier]);
}

export function consumerCredentialPath(appIdentifier: string, consumerId: string): string {
  return encodeSegments(["apps", "oauth", "credentials", appIdentifier, consumerId]);
}

export function stagedCredentialsPath(
  appIdentifier: string,
  consumerId: string,
  stagedCredentialId?: string
): string {
  const segments = ["apps", "oauth", "credentials", appIdentifier, consumerId, "staged"];
  if (stagedCredentialId) {
    segments.push(stagedCredentialId);
  }
  return encodeSegments(segments);
}

export function oauthUsagePath(): string {
  return "/apps/oauth/usage";
}
