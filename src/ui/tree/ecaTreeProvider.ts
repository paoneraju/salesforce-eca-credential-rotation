import * as vscode from "vscode";
import type { Eca } from "../../core/types";
import type { ExtensionState } from "../extensionState";
import { ecaTooltip, maskCredential, shortId } from "./presentation";

export class EcaTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
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
    if (!this.state.selectedOrg) {
      return [];
    }

    if (!this.state.selectedOrgAvailable) {
      return [this.messageItem(
        "Selected org is not available in the Salesforce CLI",
        "Select or re-authenticate the org to discover External Client Apps.",
        "warning",
        "salesforceEca.selectOrg"
      )];
    }

    if (this.state.ecasLoading) {
      const item = new vscode.TreeItem(
        "Discovering External Client Apps…",
        vscode.TreeItemCollapsibleState.None
      );
      item.iconPath = new vscode.ThemeIcon("loading~spin");
      return [item];
    }

    if (this.state.ecasError) {
      return [this.messageItem(
        "Could not discover External Client Apps",
        this.state.ecasError,
        "error",
        "salesforceEca.refreshEcas"
      )];
    }

    return this.state.ecas.map((eca) => this.ecaItem(eca));
  }

  private ecaItem(eca: Eca): vscode.TreeItem {
    const selected =
      this.state.selectedEca?.identifier === eca.identifier &&
      this.state.selectedEca?.consumer?.id === eca.consumer?.id;
    const item = new vscode.TreeItem(
      eca.name,
      vscode.TreeItemCollapsibleState.None
    );
    item.id = `eca:${eca.identifier}:${eca.consumer?.id ?? "none"}`;
    item.description = [
      selected ? "Selected" : undefined,
      eca.isFromPackage ? "Packaged" : "Local",
      `consumer ${eca.consumer ? shortId(eca.consumer.id) : "n/a"}`,
      eca.supported ? `client ${maskCredential(eca.consumer?.key)}` : "unsupported"
    ]
      .filter(Boolean)
      .join(" • ");
    item.tooltip = ecaTooltip(eca, selected);
    item.contextValue = eca.supported ? "eca.supported" : "eca.unsupported";
    item.command = {
      command: "salesforceEca.showEcaDetails",
      title: "Show External Client App Details",
      arguments: [eca]
    };
    item.iconPath = selected
      ? new vscode.ThemeIcon("key", new vscode.ThemeColor("charts.green"))
      : eca.supported
        ? new vscode.ThemeIcon("key")
        : new vscode.ThemeIcon("lock");
    return item;
  }

  private messageItem(
    label: string,
    description: string,
    icon: "warning" | "error" | "info",
    command: string
  ): vscode.TreeItem {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = description;
    item.iconPath = new vscode.ThemeIcon(
      icon,
      new vscode.ThemeColor(icon === "error" ? "charts.red" : icon === "warning" ? "charts.yellow" : "charts.blue")
    );
    item.command = { command, title: label };
    return item;
  }
}
