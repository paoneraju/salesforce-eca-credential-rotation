import * as vscode from "vscode";
import type { AuditEntry } from "../../core/audit/auditService";
import type { ExtensionState } from "../extensionState";
import { auditIcon, auditOutcomeLabel, auditTooltip, formatTimestamp } from "./presentation";

export class AuditTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly state: ExtensionState) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    if (this.state.auditLoading) {
      const item = new vscode.TreeItem("Loading rotation history…", vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("loading~spin");
      return [item];
    }
    if (this.state.auditError) {
      const item = new vscode.TreeItem("Could not read rotation history", vscode.TreeItemCollapsibleState.None);
      item.description = "Click to retry";
      item.tooltip = this.state.auditError;
      item.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
      item.command = { command: "salesforceEca.refreshAudit", title: "Refresh Rotation History" };
      return [item];
    }
    return this.state.auditEntries.map((entry) => this.auditItem(entry));
  }

  private auditItem(entry: AuditEntry): vscode.TreeItem {
    const record = entry.record;
    const item = new vscode.TreeItem(
      `${record.eca.developerName}: ${auditOutcomeLabel(entry)}`,
      vscode.TreeItemCollapsibleState.None
    );
    item.id = `audit:${record.auditId}`;
    item.description = `${formatTimestamp(record.timestamp)} • ${record.org.alias ?? record.org.username}`;
    item.tooltip = auditTooltip(entry);
    item.iconPath = auditIcon(entry);
    item.contextValue = "audit.record";
    item.command = {
      command: "salesforceEca.openAuditRecord",
      title: "Open Rotation Audit Record",
      arguments: [entry]
    };
    return item;
  }
}
