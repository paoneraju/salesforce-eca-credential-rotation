import type {
  PreflightCheck,
  RotationOutcome,
  SalesforceOrg,
  StagedCredentialInfo
} from "../../core/types";

export type WizardIntent = "full" | "stage" | "retrieve";

export type WizardStep =
  | "preflight"
  | "staged"
  | "retrieved"
  | "checklist"
  | "approval"
  | "result"
  | "failed";

export interface WizardOrgView {
  alias?: string;
  username: string;
  environment: string;
  instanceUrl: string;
}

export interface WizardEcaView {
  name: string;
  developerName: string;
  identifier: string;
  consumerId?: string;
  isFromPackage: boolean;
  supported: boolean;
  unsupportedReason?: string;
}

export interface WizardPreflightView {
  checks: PreflightCheck[];
  canStage: boolean;
  apiVersion: string;
  existingStaged: StagedCredentialInfo[];
}

export interface WizardCredentialsView {
  clientId: string;
  stagedCredentialId: string;
  retrievedAt: string;
  expirationDate?: string;
  revealed: boolean;
  /** Present only after an explicit Reveal action, and removed when re-masked. */
  secret?: string;
  expiresInSeconds?: number;
}

export interface WizardResultView {
  status: RotationOutcome["status"];
  rotatedAt: string;
  httpStatus: number;
  admin: string;
  apiVersion: string;
  auditId: string;
  auditPath?: string;
  staged: StagedCredentialInfo;
  verification: RotationOutcome["verification"];
  authenticationTested: boolean;
}

export interface WizardErrorView {
  message: string;
  auditId?: string;
  auditPath?: string;
}

export interface WizardViewModel {
  type: "state";
  step: WizardStep;
  busy: boolean;
  intent: WizardIntent;
  org: WizardOrgView;
  eca: WizardEcaView;
  preflight?: WizardPreflightView;
  staged?: StagedCredentialInfo;
  credentials?: WizardCredentialsView;
  checklistAcknowledged: boolean;
  result?: WizardResultView;
  error?: WizardErrorView;
  notice?: string;
}

export function orgView(org: SalesforceOrg): WizardOrgView {
  return {
    alias: org.alias,
    username: org.username,
    environment: org.environment,
    instanceUrl: org.instanceUrl
  };
}
