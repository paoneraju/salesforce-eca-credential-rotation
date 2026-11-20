import type { IntegrationValidationResult } from "../types";
import { Logger, NoopLogger } from "../logger";
import { redact } from "../redact";
import { HttpTransport, TransportError, assertSalesforceInstanceUrl } from "../api/http";
import { parseSalesforceError } from "../api/salesforceClient";

export interface ClientCredentialsValidationOptions {
  instanceUrl: string;
  clientId: string;
  clientSecret: string;
  transport: HttpTransport;
  timeoutMs?: number;
  logger?: Logger;
  now?: () => Date;
}

interface TokenResponse {
  access_token?: unknown;
  token_type?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/**
 * Optional, explicit integration check for ECAs that use the OAuth Client Credentials
 * flow with a Run-As user. The access token returned by Salesforce is discarded.
 */
export async function validateClientCredentials(
  options: ClientCredentialsValidationOptions
): Promise<IntegrationValidationResult> {
  const logger = options.logger ?? new NoopLogger();
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const baseUrl = assertSalesforceInstanceUrl(options.instanceUrl);
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: options.clientId,
    client_secret: options.clientSecret
  }).toString();

  logger.info("Attempting optional OAuth Client Credentials validation. Secrets are not logged.");

  try {
    const response = await options.transport.request({
      url: `${baseUrl}/services/oauth2/token`,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body,
      timeoutMs: options.timeoutMs ?? 20000
    });

    if (response.status >= 200 && response.status < 300) {
      let parsed: TokenResponse | undefined;
      try {
        parsed = JSON.parse(response.body) as TokenResponse;
      } catch {
        parsed = undefined;
      }
      if (parsed && typeof parsed.access_token === "string" && parsed.access_token) {
        // Discard the token immediately. It is never returned, logged, or stored.
        logger.info("OAuth Client Credentials validation succeeded; the issued token was discarded.");
        return {
          ok: true,
          checkedAt,
          status: response.status,
          detail: "Salesforce issued an OAuth access token for the new client credentials."
        };
      }
      return {
        ok: false,
        checkedAt,
        status: response.status,
        detail: "Salesforce returned a success status but no access token. The app may not be configured for Client Credentials Flow."
      };
    }

    const parsed = parseSalesforceError(response.body);
    const code =
      parsed.code && /^[a-z_]+$/i.test(parsed.code) ? parsed.code : undefined;
    const detail = redact(parsed.message);
    logger.warn(
      `OAuth Client Credentials validation failed with HTTP ${response.status}${code ? ` (${code})` : ""}.`
    );
    return {
      ok: false,
      checkedAt,
      status: response.status,
      errorCode: code,
      detail:
        code === "invalid_client"
          ? "Salesforce rejected the client credentials. Confirm the new client ID/secret and that Client Credentials Flow is enabled."
          : code === "invalid_grant" || /no client credentials user enabled/i.test(detail)
            ? "Salesforce rejected the Client Credentials grant. Enable the flow in the ECA policy and assign a Run-As user."
            : detail
    };
  } catch (error) {
    const timedOut = error instanceof TransportError && error.code === "TIMEOUT";
    logger.warn(`OAuth Client Credentials validation could not complete: ${timedOut ? "timeout" : "network error"}.`);
    return {
      ok: false,
      checkedAt,
      status: 0,
      detail: timedOut
        ? "The OAuth token request timed out. No conclusion can be drawn about the new credentials."
        : "The OAuth token request could not reach Salesforce. No conclusion can be drawn about the new credentials."
    };
  }
}
