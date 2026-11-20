/** Shared domain types. Nothing in this file may contain a persisted secret. */

export type OrgEnvironment = "Production" | "Sandbox" | "Scratch Org" | "Dev Hub" | "Unknown";

export type OrgConnectionStatus = "connected" | "expired" | "unreachable" | "unknown";

export interface SalesforceOrg {
  alias?: string;
  username: string;
  orgId?: string;
  instanceUrl: string;
  environment: OrgEnvironment;
  isDevHub: boolean;
  isSandbox: boolean;
  isScratch: boolean;
  connectedStatus?: string;
  status: OrgConnectionStatus;
  isDefault?: boolean;
  lastUsed?: string;
}

/**
 * An authenticated org session. The access token is deliberately non-enumerable and
 * excluded from JSON serialization so an accidental log or state write cannot persist it.
 */
export class OrgSession {
  readonly org: SalesforceOrg;
  readonly apiVersion?: string;
  readonly clientId?: string;
  readonly sessionId: string;
  #accessToken: string;
  #cleared = false;

  constructor(options: {
    org: SalesforceOrg;
    accessToken: string;
    apiVersion?: string;
    clientId?: string;
    sessionId?: string;
  }) {
    if (!options.accessToken) {
      throw new Error("Cannot create an org session without an access token.");
    }
    this.org = options.org;
    this.apiVersion = options.apiVersion;
    this.clientId = options.clientId;
    this.sessionId = options.sessionId ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.#accessToken = options.accessToken;
  }

  get accessToken(): string {
    if (this.#cleared) {
      throw new Error("The Salesforce session has been cleared.");
    }
    return this.#accessToken;
  }

  get isCleared(): boolean {
    return this.#cleared;
  }

  clear(): void {
    this.#accessToken = "";
    this.#cleared = true;
  }

  toJSON(): Record<string, unknown> {
    return {
      org: this.org,
      apiVersion: this.apiVersion,
      clientId: this.clientId,
      sessionId: this.sessionId
    };
  }
}

export interface EcaConsumer {
  /** OAuth consumer identifier, for example 888... */
  id: string;
  /** Current consumer key (client ID). Not a secret, but not displayed in full by default. */
  key?: string;
  name?: string;
  url?: string;
  stagedCredentialsUrl?: string;
}

export interface Eca {
  /** External Client App identifier, for example 0xI... */
  identifier: string;
  /** API/developer name of the External Client App. */
  developerName: string;
  /** Display name. */
  name: string;
  description?: string;
  isFromPackage: boolean;
  accessTokenFormat?: string;
  availableActions?: string[];
  consumer?: EcaConsumer;
  orgUsername: string;
  orgAlias?: string;
  supported: boolean;
  unsupportedReason?: string;
}

export type StagedCredentialState = "active" | "rotated" | "unknown";

/** Metadata only. Key and secret are intentionally absent. */
export interface StagedCredentialInfo {
  id: string;
  state: StagedCredentialState;
  createdBy?: string;
  createdDate?: string;
  expirationDate?: string;
  url?: string;
}

/** Holds a live credential value in memory only. Never persist or log this object. */
export interface StagedCredentialSecret {
  stagedCredentialId: string;
  clientId: string;
  clientSecret: string;
  state: StagedCredentialState;
  retrievedAt: string;
  expirationDate?: string;
}

export type CheckSeverity = "pass" | "warn" | "fail";

export interface PreflightCheck {
  id: string;
  label: string;
  severity: CheckSeverity;
  detail: string;
}

export interface PreflightResult {
  checks: PreflightCheck[];
  canStage: boolean;
  existingStaged: StagedCredentialInfo[];
  apiVersion: string;
  consumer: EcaConsumer;
}

export type RotationVerificationStatus = "verified" | "unverified" | "failed";

export interface RotationVerification {
  checkedAt: string;
  stagedState: StagedCredentialState;
  expectedRotatedState: boolean;
  activeConsumerKeyMatches: boolean;
  consumerKeySuffix?: string;
  detail: string;
}

export interface RotationOutcome {
  status: RotationVerificationStatus;
  rotatedAt: string;
  httpStatus: number;
  staged: StagedCredentialInfo;
  verification: RotationVerification;
  auditId: string;
  auditPath?: string;
  org: SalesforceOrg;
  eca: Eca;
  admin: string;
  apiVersion: string;
  /** Explicitly records that an API verification is not an authentication test. */
  authenticationTested: boolean;
}

export type IntegrationValidationResult =
  | {
      ok: true;
      checkedAt: string;
      status: number;
      detail: string;
    }
  | {
      ok: false;
      checkedAt: string;
      status: number;
      errorCode?: string;
      detail: string;
    };

export interface OrgAuditSnapshot {
  alias?: string;
  username: string;
  orgId?: string;
  instanceUrl: string;
  environment: OrgEnvironment;
}

export interface EcaAuditSnapshot {
  developerName: string;
  name: string;
  identifier: string;
  consumerId?: string;
  isFromPackage: boolean;
}

export type AuditAction =
  | "preflight"
  | "stage"
  | "retrieve"
  | "rotate"
  | "integration-validation"
  | "delete-staged";

export type AuditOutcome = "success" | "verified" | "unverified" | "failed" | "blocked";

export interface AuditRecord {
  auditId: string;
  timestamp: string;
  action: AuditAction;
  outcome: AuditOutcome;
  org: OrgAuditSnapshot;
  eca: EcaAuditSnapshot;
  admin: string;
  apiVersion?: string;
  stagedCredential?: {
    id: string;
    state: StagedCredentialState;
    createdDate?: string;
    expirationDate?: string;
  };
  httpStatus?: number;
  verification?: {
    stagedState: StagedCredentialState;
    activeConsumerKeyMatches: boolean;
    checkedAt: string;
  };
  integrationValidation?: {
    attempted: boolean;
    ok?: boolean;
    errorCode?: string;
  };
  error?: {
    code: string;
    message: string;
  };
  extensionVersion: string;
  note?: string;
}
