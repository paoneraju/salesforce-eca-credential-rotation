import * as vscode from "vscode";
import type { AuditEntry } from "../../core/audit/auditService";
import type { Eca, SalesforceOrg } from "../../core/types";

export function maskCredential(value: string | undefined): string {
  if (!value) {
    return "not reported";
  }
  if (value.length <= 8) {
    return "••••••••";
  }
  return `${"•".repeat(Math.min(12, value.length - 4))}${value.slice(-4)}`;
}

export function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

export function connectionLabel(org: SalesforceOrg): string {
  switch (org.status) {
    case "connected":
      return "Connected";
    case "expired":
      return "Session expired";
    case "unreachable":
      return "Unreachable";
    default:
      return "Unknown";
  }
}

export function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString();
}

export function orgTooltip(org: SalesforceOrg, active: boolean): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**${active ? "Active Salesforce org" : "Salesforce org"}**\n\n`);
  tooltip.appendText(`Alias: ${org.alias ?? "none"}\n`);
  tooltip.appendText(`Username: ${org.username}\n`);
  tooltip.appendText(`Environment: ${org.environment}\n`);
  tooltip.appendText(`Instance: ${org.instanceUrl}\n`);
  tooltip.appendText(`CLI status: ${connectionLabel(org)}\n`);
  if (org.orgId) {
    tooltip.appendText(`Org ID: ${org.orgId}\n`);
  }
  if (org.connectedStatus) {
    tooltip.appendText(`Detail: ${org.connectedStatus}`);
  }
  return tooltip;
}

export function ecaTooltip(eca: Eca, selected: boolean): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**${selected ? "Selected External Client App" : "External Client App"}**\n\n`);
  tooltip.appendText(`Name: ${eca.name}\n`);
  tooltip.appendText(`API name: ${eca.developerName}\n`);
  tooltip.appendText(`Identifier: ${eca.identifier}\n`);
  tooltip.appendText(`Consumer ID: ${eca.consumer?.id ?? "not available"}\n`);
  tooltip.appendText(`Current client ID: ${maskCredential(eca.consumer?.key)}\n`);
  tooltip.appendText(`Distribution: ${eca.isFromPackage ? "Packaged" : "Local"}\n`);
  tooltip.appendText(`Org: ${eca.orgAlias ?? eca.orgUsername}\n`);
  if (eca.description) {
    tooltip.appendText(`Description: ${eca.description}\n`);
  }
  if (!eca.supported) {
    tooltip.appendText(`Rotation: unsupported — ${eca.unsupportedReason ?? "not eligible"}\n`);
  } else {
    tooltip.appendText("Rotation: supported (administrator approval required)");
  }
  return tooltip;
}

export function auditOutcomeLabel(entry: AuditEntry): string {
  switch (entry.record.outcome) {
    case "verified":
      return "Verified";
    case "unverified":
      return "Unverified";
    case "failed":
      return "Failed";
    case "blocked":
      return "Blocked";
    default:
      return "Completed";
  }
}

export function auditTooltip(entry: AuditEntry): vscode.MarkdownString {
  const record = entry.record;
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**Rotation audit record**\n\n`);
  tooltip.appendText(`Audit ID: ${record.auditId}\n`);
  tooltip.appendText(`Timestamp: ${formatTimestamp(record.timestamp)}\n`);
  tooltip.appendText(`Action: ${record.action}\n`);
  tooltip.appendText(`Outcome: ${record.outcome}\n`);
  tooltip.appendText(`Org: ${record.org.alias ?? record.org.username} (${record.org.environment})\n`);
  tooltip.appendText(`External Client App: ${record.eca.developerName}\n`);
  if (record.eca.consumerId) {
    tooltip.appendText(`Consumer ID: ${record.eca.consumerId}\n`);
  }
  if (record.stagedCredential) {
    tooltip.appendText(`Staged credential: ${record.stagedCredential.id} (${record.stagedCredential.state})\n`);
    if (record.stagedCredential.expirationDate) {
      tooltip.appendText(`Expires: ${formatTimestamp(record.stagedCredential.expirationDate)}\n`);
    }
  }
  if (record.httpStatus !== undefined) {
    tooltip.appendText(`HTTP status: ${record.httpStatus}\n`);
  }
  if (record.verification) {
    tooltip.appendText(
      `Verification: state=${record.verification.stagedState}, active key matches=${record.verification.activeConsumerKeyMatches}\n`
    );
  }
  if (record.error) {
    tooltip.appendText(`Error: ${record.error.code} — ${record.error.message}\n`);
  }
  if (record.note) {
    tooltip.appendText(`Note: ${record.note}\n`);
  }
  tooltip.appendText("No client IDs, secrets, or access tokens are stored in audit records.");
  return tooltip;
}

export function auditIcon(entry: AuditEntry): vscode.ThemeIcon {
  switch (entry.record.outcome) {
    case "verified":
      return new vscode.ThemeIcon("pass", new vscode.ThemeColor("charts.green"));
    case "unverified":
      return new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.yellow"));
    case "failed":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
    default:
      return new vscode.ThemeIcon("history");
  }
}
