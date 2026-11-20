import * as path from "node:path";
import * as vscode from "vscode";
import type { ExtensionContext } from "vscode";
import { assertSalesforceInstanceUrl } from "../core/api/http";
import type { SalesforceOrg } from "../core/types";

export interface ExtensionSettings {
  sfCliPath: string;
  apiVersion: string;
  cliTimeoutMs: number;
  requestTimeoutMs: number;
  credentialTtlMinutes: number;
  auditDirectory: string;
}

export const SELECTED_ORG_KEY = "salesforceEca.selectedOrg.v1";

export function readSettings(): ExtensionSettings {
  const configuration = vscode.workspace.getConfiguration("salesforceEca");
  return {
    sfCliPath: configuration.get<string>("sfCliPath", "sf").trim() || "sf",
    apiVersion: configuration.get<string>("apiVersion", "").trim(),
    cliTimeoutMs: configuration.get<number>("cliTimeoutMs", 60000),
    requestTimeoutMs: configuration.get<number>("requestTimeoutMs", 30000),
    credentialTtlMinutes: configuration.get<number>("credentialSessionTtlMinutes", 10),
    auditDirectory: configuration.get<string>("auditDirectory", "").trim()
  };
}

export function resolveAuditDirectory(settings: ExtensionSettings, context: ExtensionContext): string {
  if (!settings.auditDirectory) {
    return path.join(context.globalStorageUri.fsPath, "audit");
  }
  if (path.isAbsolute(settings.auditDirectory)) {
    return settings.auditDirectory;
  }
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return path.join(context.globalStorageUri.fsPath, settings.auditDirectory);
  }
  return path.resolve(workspaceFolder.uri.fsPath, settings.auditDirectory);
}

export function serializeOrg(org: SalesforceOrg): SalesforceOrg {
  return {
    alias: org.alias,
    username: org.username,
    orgId: org.orgId,
    instanceUrl: org.instanceUrl,
    environment: org.environment,
    isDevHub: org.isDevHub,
    isSandbox: org.isSandbox,
    isScratch: org.isScratch,
    connectedStatus: org.connectedStatus,
    status: org.status,
    isDefault: org.isDefault,
    lastUsed: org.lastUsed
  };
}

export function deserializeOrg(raw: unknown): SalesforceOrg | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.username !== "string" || typeof value.instanceUrl !== "string") {
    return undefined;
  }
  let instanceUrl: string;
  try {
    instanceUrl = assertSalesforceInstanceUrl(value.instanceUrl);
  } catch {
    return undefined;
  }
  const environment =
    value.environment === "Production" ||
    value.environment === "Sandbox" ||
    value.environment === "Scratch Org" ||
    value.environment === "Dev Hub"
      ? value.environment
      : "Unknown";
  return {
    alias: typeof value.alias === "string" ? value.alias : undefined,
    username: value.username,
    orgId: typeof value.orgId === "string" ? value.orgId : undefined,
    instanceUrl,
    environment,
    isDevHub: value.isDevHub === true,
    isSandbox: value.isSandbox === true,
    isScratch: value.isScratch === true,
    connectedStatus: typeof value.connectedStatus === "string" ? value.connectedStatus : undefined,
    status:
      value.status === "connected" ||
      value.status === "expired" ||
      value.status === "unreachable" ||
      value.status === "unknown"
        ? value.status
        : "unknown",
    isDefault: value.isDefault === true,
    lastUsed: typeof value.lastUsed === "string" ? value.lastUsed : undefined
  };
}

export function sameOrg(left: SalesforceOrg | undefined, right: SalesforceOrg | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  if (left.orgId && right.orgId) {
    return left.orgId === right.orgId && left.username.toLowerCase() === right.username.toLowerCase();
  }
  return left.username.toLowerCase() === right.username.toLowerCase();
}
