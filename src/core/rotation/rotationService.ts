import { AppError } from "../errors";
import { Logger, NoopLogger, errorSummary } from "../logger";
import { redact } from "../redact";
import type {
  Eca,
  EcaAuditSnapshot,
  IntegrationValidationResult,
  OrgAuditSnapshot,
  OrgSession,
  PreflightCheck,
  PreflightResult,
  RotationOutcome,
  SalesforceOrg,
  StagedCredentialInfo
} from "../types";
import type { AuditRecordInput, AuditService, AuditWriteResult } from "../audit/auditService";
import type { CredentialScope, CredentialSession } from "../credentials/credentialSession";
import { EcaApi, validateConsumerIdentifier, validateEcaIdentifier } from "../api/ecaApi";
import type { HttpTransport } from "../api/http";
import { validateClientCredentials } from "../validation/integrationValidator";

export interface SessionProvider {
  assertSession(org: SalesforceOrg): Promise<OrgSession>;
}

export type EcaApiProvider = (session: OrgSession) => EcaApi;

export interface RotationServiceOptions {
  sessions: SessionProvider;
  apiFactory: EcaApiProvider;
  audit: AuditService;
  credentials: CredentialSession;
  transport: HttpTransport;
  logger?: Logger;
  now?: () => Date;
  requestTimeoutMs?: number;
}

export class RotationFailedError extends AppError {
  readonly auditId: string;
  readonly auditPath?: string;
  readonly httpStatus?: number;

  constructor(message: string, options: { auditId: string; auditPath?: string; httpStatus?: number; cause?: unknown }) {
    super({
      code: "ROTATION_FAILED",
      userMessage: message,
      cause: options.cause
    });
    this.name = "RotationFailedError";
    this.auditId = options.auditId;
    this.auditPath = options.auditPath;
    this.httpStatus = options.httpStatus;
  }
}

function orgSnapshot(org: SalesforceOrg): OrgAuditSnapshot {
  return {
    alias: org.alias,
    username: org.username,
    orgId: org.orgId,
    instanceUrl: org.instanceUrl,
    environment: org.environment
  };
}

function ecaSnapshot(eca: Eca): EcaAuditSnapshot {
  return {
    developerName: eca.developerName,
    name: eca.name,
    identifier: eca.identifier,
    consumerId: eca.consumer?.id,
    isFromPackage: eca.isFromPackage
  };
}

function requireConsumer(eca: Eca): NonNullable<Eca["consumer"]> {
  if (!eca.consumer) {
    throw new AppError({
      code: "UNSUPPORTED",
      userMessage: "This External Client App has no accessible OAuth consumer and cannot be rotated."
    });
  }
  return eca.consumer;
}

function scopeFor(org: SalesforceOrg, eca: Eca): CredentialScope {
  return {
    orgId: org.orgId,
    orgUsername: org.username,
    appIdentifier: eca.identifier,
    consumerId: requireConsumer(eca).id
  };
}

function formatDate(value: string | undefined): string {
  if (!value) {
    return "not reported";
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString();
}

function stagedSummary(staged: StagedCredentialInfo): string {
  const expires = staged.expirationDate ? `, expires ${formatDate(staged.expirationDate)}` : "";
  return `${staged.state} (${staged.id}${expires})`;
}

export class RotationService {
  private readonly sessions: SessionProvider;
  private readonly apiFactory: EcaApiProvider;
  private readonly audit: AuditService;
  private readonly credentials: CredentialSession;
  private readonly transport: HttpTransport;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly requestTimeoutMs: number;

  constructor(options: RotationServiceOptions) {
    this.sessions = options.sessions;
    this.apiFactory = options.apiFactory;
    this.audit = options.audit;
    this.credentials = options.credentials;
    this.transport = options.transport;
    this.logger = options.logger ?? new NoopLogger();
    this.now = options.now ?? (() => new Date());
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
  }

  async preflight(org: SalesforceOrg, eca: Eca): Promise<PreflightResult> {
    const checks: PreflightCheck[] = [];
    validateEcaIdentifier(eca.identifier);
    const consumer = requireConsumer(eca);
    validateConsumerIdentifier(consumer.id);

    if (eca.isFromPackage) {
      checks.push({
        id: "packaged",
        label: "Local External Client App",
        severity: "fail",
        detail: "Packaged External Client Apps are managed by their package and cannot be rotated here."
      });
    } else {
      checks.push({
        id: "packaged",
        label: "Local External Client App",
        severity: "pass",
        detail: "The app is local to this org."
      });
    }

    if (!eca.supported) {
      checks.push({
        id: "supported",
        label: "Rotation supported",
        severity: "fail",
        detail: eca.unsupportedReason ?? "This app is not eligible for credential rotation."
      });
    }

    const session = await this.sessions.assertSession(org);
    checks.push({
      id: "session",
      label: "CLI session and org identity",
      severity: "pass",
      detail: `Validated ${session.org.username} against the selected org.`
    });

    const api = this.apiFactory(session);
    const apiVersion = await api.getApiVersion();
    checks.push({
      id: "api-version",
      label: "Salesforce API version",
      severity: "pass",
      detail: `Using ${apiVersion}; credential rotation requires v65.0 or later.`
    });

    const liveConsumer = await api.validateConsumer(eca.identifier, consumer.id);
    checks.push({
      id: "consumer",
      label: "OAuth consumer access",
      severity: "pass",
      detail: `Consumer ${liveConsumer.id} is accessible to this user.`
    });

    if (session.clientId && liveConsumer.key && session.clientId === liveConsumer.key) {
      checks.push({
        id: "self-session",
        label: "Credential is not the active CLI client",
        severity: "fail",
        detail:
          "The selected ECA consumer key matches the CLI session's OAuth client. Rotating it would invalidate the session performing the rotation."
      });
    } else {
      checks.push({
        id: "self-session",
        label: "Credential is not the active CLI client",
        severity: "pass",
        detail: "The CLI session is not authenticated with this consumer key."
      });
    }

    let existingStaged: StagedCredentialInfo[] = [];
    try {
      existingStaged = await api.listStagedCredentials(eca.identifier, consumer.id);
      const active = existingStaged.filter((entry) => entry.state === "active");
      const rotated = existingStaged.filter((entry) => entry.state === "rotated");
      if (active.length > 0) {
        checks.push({
          id: "staged",
          label: "Existing staged credentials",
          severity: "warn",
          detail: `An active staged credential already exists: ${active.map(stagedSummary).join("; ")}. Staging again replaces it.`
        });
      } else if (rotated.length > 0) {
        checks.push({
          id: "staged",
          label: "Existing staged credentials",
          severity: "warn",
          detail: `A previously rotated credential is still retained: ${rotated.map(stagedSummary).join("; ")}. Staging again replaces it.`
        });
      } else {
        checks.push({
          id: "staged",
          label: "Existing staged credentials",
          severity: "pass",
          detail: "No staged credentials currently exist."
        });
      }
    } catch (error) {
      checks.push({
        id: "staged",
        label: "Existing staged credentials",
        severity: "warn",
        detail: `Could not read staged credential status: ${errorSummary(error)}`
      });
    }

    checks.push({
      id: "secret-access",
      label: "Staged secret retrieval",
      severity: "warn",
      detail:
        "Retrieving the client secret requires Setup > External Client Apps > Settings > Allow access to External Client App consumer secrets via REST API. If retrieval fails, confirm that this setting is enabled."
    });

    const canStage = !checks.some((check) => check.severity === "fail");
    return { checks, canStage, existingStaged, apiVersion, consumer: liveConsumer };
  }

  async stage(
    org: SalesforceOrg,
    eca: Eca,
    options: { acknowledgeExistingStaged?: boolean }
  ): Promise<{ staged: StagedCredentialInfo; apiVersion: string; httpStatus: number }> {
    const consumer = requireConsumer(eca);
    validateEcaIdentifier(eca.identifier);
    validateConsumerIdentifier(consumer.id);

    try {
      const session = await this.sessions.assertSession(org);
      const api = this.apiFactory(session);
      const apiVersion = await api.getApiVersion();
      await api.validateConsumer(eca.identifier, consumer.id);

      if (!options.acknowledgeExistingStaged) {
        const existing = await api.listStagedCredentials(eca.identifier, consumer.id);
        if (existing.some((entry) => entry.state === "active")) {
          throw new AppError({
            code: "VALIDATION",
            userMessage:
              "An active staged credential already exists. Confirm that it should be replaced before staging new credentials."
          });
        }
      }

      const result = await api.stageCredentials(eca.identifier, consumer.id);
      await this.audit.record(
        this.baseAudit(org, eca, "stage", "success", session, apiVersion, {
          stagedCredential: {
            id: result.staged.id,
            state: result.staged.state,
            createdDate: result.staged.createdDate,
            expirationDate: result.staged.expirationDate
          },
          httpStatus: result.httpStatus,
          note: "Staged credentials are active for OAuth but have not replaced the current credentials."
        })
      );
      return { staged: result.staged, apiVersion, httpStatus: result.httpStatus };
    } catch (error) {
      if (error instanceof AppError && error.code === "VALIDATION" && /active staged credential/.test(error.userMessage)) {
        throw error;
      }
      await this.auditFailure(org, eca, "stage", error);
      throw error;
    }
  }

  async retrieve(
    org: SalesforceOrg,
    eca: Eca,
    stagedCredentialId: string,
    options: { explicit: boolean }
  ): Promise<{ clientId: string; clientSecret: string; staged: StagedCredentialInfo }> {
    if (!options.explicit) {
      throw new AppError({
        code: "VALIDATION",
        userMessage:
          "Staged credential values are only retrieved after an explicit administrator action."
      });
    }
    const consumer = requireConsumer(eca);
    try {
      const session = await this.sessions.assertSession(org);
      const api = this.apiFactory(session);
      await api.validateConsumer(eca.identifier, consumer.id);
      const secret = await api.retrieveStagedCredential(
        eca.identifier,
        consumer.id,
        stagedCredentialId
      );
      this.credentials.set(scopeFor(org, eca), secret);
      const staged = await this.findStagedOrPlaceholder(api, eca, stagedCredentialId);
      await this.audit.record(
        this.baseAudit(org, eca, "retrieve", "success", session, await api.getApiVersion(), {
          stagedCredential: {
            id: staged.id,
            state: staged.state,
            createdDate: staged.createdDate,
            expirationDate: staged.expirationDate
          },
          note: "Credential values were returned to the extension UI in memory only; no values were written to the audit log."
        })
      );
      return { clientId: secret.clientId, clientSecret: secret.clientSecret, staged };
    } catch (error) {
      await this.auditFailure(org, eca, "retrieve", error);
      throw error;
    }
  }

  async rotate(
    org: SalesforceOrg,
    eca: Eca,
    stagedCredentialId: string,
    approval: { confirmed: boolean; checklistAcknowledged: boolean; typedEcaName: string }
  ): Promise<RotationOutcome> {
    if (!approval.confirmed) {
      throw new AppError({
        code: "CANCELLED",
        userMessage: "Rotation was not confirmed. No changes were made."
      });
    }
    if (!approval.checklistAcknowledged) {
      throw new AppError({
        code: "VALIDATION",
        userMessage: "Complete the integration update checklist before rotating credentials."
      });
    }
    if (approval.typedEcaName.trim() !== eca.developerName) {
      throw new AppError({
        code: "VALIDATION",
        userMessage: `Type the External Client App API name (${eca.developerName}) exactly to approve rotation.`
      });
    }

    const consumer = requireConsumer(eca);
    const scope = scopeFor(org, eca);
    const held = this.credentials.get(scope);
    if (!held || held.stagedCredentialId !== stagedCredentialId) {
      throw new AppError({
        code: "VALIDATION",
        userMessage:
          "Retrieve the staged credentials in this session before rotating. Rotation requires the administrator to have access to the new client ID and secret."
      });
    }

    let session: OrgSession;
    try {
      session = await this.sessions.assertSession(org);
    } catch (error) {
      await this.auditFailure(org, eca, "rotate", error);
      throw error;
    }

    const api = this.apiFactory(session);
    const apiVersion = await api.getApiVersion();

    try {
      await api.validateConsumer(eca.identifier, consumer.id);
      const currentStaged = await api.listStagedCredentials(eca.identifier, consumer.id);
      const target = currentStaged.find((entry) => entry.id === stagedCredentialId);
      if (!target) {
        throw new AppError({
          code: "VALIDATION",
          userMessage:
            "The staged credential is no longer present. Stage and retrieve new credentials before rotating."
        });
      }
      if (target.state === "rotated") {
        throw new AppError({
          code: "VALIDATION",
          userMessage: "This staged credential has already been rotated. No further rotation was performed."
        });
      }
      if (target.state !== "active") {
        throw new AppError({
          code: "VALIDATION",
          userMessage: `The staged credential is in an unexpected state (${target.state}) and cannot be rotated.`
        });
      }
    } catch (error) {
      await this.auditFailure(org, eca, "rotate", error);
      throw error;
    }

    let rotateResult;
    try {
      rotateResult = await api.rotateCredential(eca.identifier, consumer.id, stagedCredentialId);
    } catch (error) {
      const write = await this.auditFailure(org, eca, "rotate", error);
      throw new RotationFailedError(
        error instanceof AppError
          ? error.userMessage
          : "Salesforce did not accept the rotation request. Do not assume that new credentials are active.",
        {
          auditId: write.record.auditId,
          auditPath: write.writeError ? undefined : write.filePath,
          httpStatus: error instanceof AppError && "status" in error ? Number(error.status) : undefined,
          cause: error
        }
      );
    }

    const checkedAt = this.now().toISOString();
    let stagedState = rotateResult.staged.state;
    let activeConsumerKey = "";
    let verificationError: string | undefined;

    try {
      const refreshed = await api.listStagedCredentials(eca.identifier, consumer.id);
      const refreshedTarget = refreshed.find((entry) => entry.id === stagedCredentialId);
      if (refreshedTarget) {
        stagedState = refreshedTarget.state;
      }
      activeConsumerKey = await api.getActiveConsumerKey(eca.identifier, consumer.id);
    } catch (error) {
      verificationError = errorSummary(error);
      this.logger.warn(`Rotation verification could not complete: ${verificationError}`);
    }

    const expectedRotatedState = rotateResult.staged.state === "rotated";
    const activeConsumerKeyMatches =
      Boolean(activeConsumerKey) && activeConsumerKey === held.clientId;
    const verified =
      expectedRotatedState &&
      stagedState === "rotated" &&
      activeConsumerKeyMatches &&
      !verificationError;

    const verificationDetail = verified
      ? "Salesforce reports the staged credential as rotated and the active consumer key matches the new client ID. This is a state check, not an authentication test."
      : verificationError
        ? `Rotation was accepted, but verification could not complete: ${verificationError}. Do not assume the new credentials are active.`
        : !expectedRotatedState || stagedState !== "rotated"
          ? `Salesforce did not report the expected rotated state (response=${rotateResult.staged.state}, refreshed=${stagedState}).`
          : "The active consumer key does not match the new client ID. Do not assume the new credentials are active.";

    const outcomeStatus = verified ? "verified" : "unverified";
    const note = verified
      ? "Rotation verified by credential state and active key comparison. The credentials were not authentication-tested."
      : "Rotation requested but not verified. No success is claimed; investigate before updating integrations.";

    const write = await this.audit.record(
      this.baseAudit(org, eca, "rotate", outcomeStatus, session, apiVersion, {
        stagedCredential: {
          id: rotateResult.staged.id,
          state: stagedState,
          createdDate: rotateResult.staged.createdDate,
          expirationDate: rotateResult.staged.expirationDate
        },
        httpStatus: rotateResult.httpStatus,
        verification: {
          stagedState,
          activeConsumerKeyMatches,
          checkedAt
        },
        note
      })
    );

    if (write.writeError) {
      this.logger.warn(`Rotation audit record could not be written: ${write.writeError}`);
    }

    const suffix = activeConsumerKey ? activeConsumerKey.slice(-4) : undefined;
    return {
      status: outcomeStatus,
      rotatedAt: checkedAt,
      httpStatus: rotateResult.httpStatus,
      staged: {
        ...rotateResult.staged,
        state: stagedState
      },
      verification: {
        checkedAt,
        stagedState,
        expectedRotatedState,
        activeConsumerKeyMatches,
        consumerKeySuffix: suffix,
        detail: verificationDetail
      },
      auditId: write.record.auditId,
      auditPath: write.writeError ? undefined : write.filePath,
      org,
      eca,
      admin: org.username,
      apiVersion,
      authenticationTested: false
    };
  }

  async validateIntegration(
    org: SalesforceOrg,
    eca: Eca,
    stagedCredentialId: string,
    options: { confirmed: boolean }
  ): Promise<IntegrationValidationResult> {
    if (!options.confirmed) {
      throw new AppError({
        code: "CANCELLED",
        userMessage: "Integration validation was cancelled."
      });
    }
    const consumer = requireConsumer(eca);
    const session = await this.sessions.assertSession(org);
    const api = this.apiFactory(session);
    await api.validateConsumer(eca.identifier, consumer.id);

    const scope = scopeFor(org, eca);
    let held = this.credentials.get(scope);
    if (!held || held.stagedCredentialId !== stagedCredentialId) {
      held = await api.retrieveStagedCredential(eca.identifier, consumer.id, stagedCredentialId);
      this.credentials.set(scope, held);
    }

    const result = await validateClientCredentials({
      instanceUrl: org.instanceUrl,
      clientId: held.clientId,
      clientSecret: held.clientSecret,
      transport: this.transport,
      timeoutMs: this.requestTimeoutMs,
      logger: this.logger,
      now: this.now
    });

    await this.audit.record(
      this.baseAudit(org, eca, "integration-validation", result.ok ? "success" : "failed", session, await api.getApiVersion(), {
        integrationValidation: {
          attempted: true,
          ok: result.ok,
          errorCode: result.ok ? undefined : result.errorCode
        },
        note: result.ok
          ? "OAuth Client Credentials grant succeeded; the issued access token was discarded."
          : "OAuth Client Credentials validation did not succeed. Credential rotation state is unaffected."
      })
    );

    return result;
  }

  async deleteStagedCredential(
    org: SalesforceOrg,
    eca: Eca,
    stagedCredentialId: string,
    options: { confirmed: boolean }
  ): Promise<void> {
    if (!options.confirmed) {
      throw new AppError({
        code: "CANCELLED",
        userMessage: "Deletion was cancelled."
      });
    }
    const consumer = requireConsumer(eca);
    try {
      const session = await this.sessions.assertSession(org);
      const api = this.apiFactory(session);
      await api.validateConsumer(eca.identifier, consumer.id);
      const httpStatus = await api.deleteStagedCredential(
        eca.identifier,
        consumer.id,
        stagedCredentialId
      );
      this.credentials.clear();
      await this.audit.record(
        this.baseAudit(org, eca, "delete-staged", "success", session, await api.getApiVersion(), {
          stagedCredential: { id: stagedCredentialId, state: "unknown" },
          httpStatus,
          note: "The staged credential was deleted. The active consumer credentials were not changed."
        })
      );
    } catch (error) {
      await this.auditFailure(org, eca, "delete-staged", error);
      throw error;
    }
  }

  private async findStagedOrPlaceholder(
    api: EcaApi,
    eca: Eca,
    stagedCredentialId: string
  ): Promise<StagedCredentialInfo> {
    const consumer = requireConsumer(eca);
    const staged = await api.listStagedCredentials(eca.identifier, consumer.id);
    return (
      staged.find((entry) => entry.id === stagedCredentialId) ?? {
        id: stagedCredentialId,
        state: "unknown"
      }
    );
  }

  private baseAudit(
    org: SalesforceOrg,
    eca: Eca,
    action: AuditRecordInput["action"],
    outcome: AuditRecordInput["outcome"],
    session: OrgSession,
    apiVersion: string,
    extras: Partial<AuditRecordInput>
  ): AuditRecordInput {
    return {
      action,
      outcome,
      org: orgSnapshot(org),
      eca: ecaSnapshot(eca),
      admin: session.org.username,
      apiVersion,
      ...extras
    };
  }

  private async auditFailure(
    org: SalesforceOrg,
    eca: Eca,
    action: AuditRecordInput["action"],
    error: unknown
  ): Promise<AuditWriteResult> {
    const appError = error instanceof AppError ? error : undefined;
    const write = await this.audit.record({
      action,
      outcome: "failed",
      org: orgSnapshot(org),
      eca: ecaSnapshot(eca),
      admin: org.username,
      error: {
        code: appError?.code ?? "INTERNAL",
        message: appError?.userMessage ?? errorSummary(error)
      },
      note: "The operation failed. No success is claimed."
    });
    if (write.writeError) {
      this.logger.warn(`Failure audit record could not be written: ${redact(write.writeError)}`);
    }
    return write;
  }
}
