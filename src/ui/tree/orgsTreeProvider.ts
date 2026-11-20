import * as vscode from "vscode";
import type { SalesforceOrg } from "../../core/types";
import type { ExtensionState } from "../extensionState";
import { connectionLabel, orgTooltip } from "./presentation";

export class OrgsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
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
    const items: vscode.TreeItem[] = [];

    if (this.state.selectedOrg && !this.state.selectedOrgAvailable) {
      const missing = new vscode.TreeItem(
        `Selected org is no longer available: ${this.state.selectedOrg.alias ?? this.state.selectedOrg.username}`,
        vscode.TreeItemCollapsibleState.None
      );
      missing.description = "Re-select or re-authenticate";
      missing.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.yellow"));
      missing.tooltip = "The extension will not switch to another org automatically.";
      missing.contextValue = "org.missing";
      missing.command = {
        command: "salesforceEca.selectOrg",
        title: "Select Salesforce Org"
      };
      items.push(missing);
    }

    if (this.state.orgsError) {
      const error = new vscode.TreeItem("Could not load Salesforce orgs", vscode.TreeItemCollapsibleState.None);
      error.description = "Click to retry";
      error.tooltip = this.state.orgsError;
      error.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
      error.contextValue = "org.error";
      error.command = {
        command: "salesforceEca.refreshOrgs",
        title: "Refresh Salesforce Orgs"
      };
      items.push(error);
    }

    if (this.state.orgsLoading && this.state.orgs.length === 0) {
      const loading = new vscode.TreeItem("Loading Salesforce orgs…", vscode.TreeItemCollapsibleState.None);
      loading.iconPath = new vscode.ThemeIcon("loading~spin");
      return [loading];
    }

    for (const org of this.state.orgs) {
      items.push(this.orgItem(org));
    }
    return items;
  }

  private orgItem(org: SalesforceOrg): vscode.TreeItem {
    const active = this.state.isSelectedOrg(org);
    const item = new vscode.TreeItem(
      org.alias ?? org.username,
      vscode.TreeItemCollapsibleState.None
    );
    item.id = `org:${org.orgId ?? org.username}`;
    item.description = `${active ? "Active • " : ""}${org.environment} • ${connectionLabel(org)}`;
    item.tooltip = orgTooltip(org, active);
    item.contextValue = active ? "org.active" : "org.available";
    item.command = {
      command: "salesforceEca.selectOrg",
      title: "Select Salesforce Org",
      arguments: [org]
    };
    if (active) {
      item.iconPath = new vscode.ThemeIcon("account", new vscode.ThemeColor("charts.blue"));
    } else if (org.status === "expired" || org.status === "unreachable") {
      item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.yellow"));
    } else {
      item.iconPath = new vscode.ThemeIcon("account");
    }
    return item;
  }
}
