import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import type { ExtensionContext } from "vscode";
import { EcaApi } from "../core/api/ecaApi";
import { assertSalesforceInstanceUrl } from "../core/api/http";
import { NodeHttpsTransport } from "../core/api/nodeHttpsTransport";
import { SalesforceClient } from "../core/api/salesforceClient";
import { AuditService, type AuditEntry } from "../core/audit/auditService";
import { SfCli } from "../core/cli/sfCli";
import { CredentialSession, type CredentialScope } from "../core/credentials/credentialSession";
import { isAuthError, toAppError } from "../core/errors";
import { OrgService } from "../core/orgs/orgService";
import { RotationService } from "../core/rotation/rotationService";
import type { Eca, OrgSession, SalesforceOrg, StagedCredentialSecret } from "../core/types";
import { ClipboardService } from "./clipboard";
import {
  SELECTED_ORG_KEY,
  deserializeOrg,
  readSettings,
  resolveAuditDirectory,
  sameOrg,
  serializeOrg,
  type ExtensionSettings
} from "./config";
import { ExtensionState, hasSupportedEca } from "./extensionState";
import { OutputChannelLogger } from "./outputChannelLogger";
import { AuditTreeProvider } from "./tree/auditTreeProvider";
import { EcaTreeProvider } from "./tree/ecaTreeProvider";
import { OrgsTreeProvider } from "./tree/orgsTreeProvider";
import { connectionLabel, maskCredential } from "./tree/presentation";
import { RotationWizard } from "./wizard/rotationWizard";
import type { WizardIntent } from "./wizard/wizardTypes";

interface RuntimeServices {
  cli: SfCli;
  orgs: OrgService;
  audit: AuditService;
  rotation: RotationService;
}

const OUTPUT_CHANNEL_NAME = "Salesforce ECA Manager";
const MAX_AUDIT_ENTRIES = 100;

function isSalesforceOrg(value: unknown): value is SalesforceOrg {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.username === "string" && typeof candidate.instanceUrl === "string";
}

function isEca(value: unknown): value is Eca {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.identifier === "string" && typeof candidate.developerName === "string";
}

function isAuditEntry(value: unknown): value is AuditEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.line !== "number" || typeof candidate.filePath !== "string") {
    return false;
  }
  const record = candidate.record;
  return (
    Boolean(record) &&
    typeof record === "object" &&
    typeof (record as Record<string, unknown>).auditId === "string"
  );
}

function quoteShellArgument(value: string): string {
  if (/^[A-Za-z0-9._@-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class ExtensionController {
  private readonly output: vscode.OutputChannel;
  private readonly logger: OutputChannelLogger;
  private readonly state = new ExtensionState();
  private readonly clipboard = new ClipboardService();
  private readonly transport = new NodeHttpsTransport();
  private readonly credentials = new CredentialSession();

  private readonly orgsProvider = new OrgsTreeProvider(this.state);
  private readonly ecaProvider = new EcaTreeProvider(this.state);
  private readonly auditProvider = new AuditTreeProvider(this.state);
  private readonly statusBar: vscode.StatusBarItem;

  private settings: ExtensionSettings;
  private services!: RuntimeServices;
  private refreshingEcas: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly context: ExtensionContext) {
    this.output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    this.logger = new OutputChannelLogger(this.output);
    this.settings = readSettings();
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.name = "Salesforce ECA Manager";
    this.buildServices(this.settings);
  }

  activate(): void {
    this.context.subscriptions.push(this.output, this.statusBar);
    this.registerViews();
    this.registerCommands();
    this.registerListeners();
    this.restoreSelectedOrg();
    this.updateContextKeys();
    this.updateStatusBar();
    void this.startup();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.credentials.clear();
  }

  private buildServices(settings: ExtensionSettings): void {
    this.credentials.setTtlMs(settings.credentialTtlMinutes * 60_000);

    const cli = new SfCli({
      sfPath: settings.sfCliPath,
      timeoutMs: settings.cliTimeoutMs,
      logger: this.logger
    });
    const orgs = new OrgService({
      cli,
      transport: this.transport,
      logger: this.logger,
      timeoutMs: settings.requestTimeoutMs,
      configuredApiVersion: () => this.settings.apiVersion
    });
    const audit = new AuditService({
      directory: resolveAuditDirectory(settings, this.context),
      extensionVersion: this.extensionVersion(),
      logger: this.logger
    });
    const rotation = new RotationService({
      sessions: orgs,
      apiFactory: (session) => this.createApi(session, settings),
      audit,
      credentials: this.credentials,
      transport: this.transport,
      logger: this.logger,
      requestTimeoutMs: settings.requestTimeoutMs
    });

    this.services = { cli, orgs, audit, rotation };
  }

  private createApi(session: OrgSession, settings: ExtensionSettings = this.settings): EcaApi {
    const client = new SalesforceClient(session, {
      transport: this.transport,
      logger: this.logger,
      timeoutMs: settings.requestTimeoutMs,
      configuredApiVersion: settings.apiVersion
    });
    return new EcaApi(client, this.logger);
  }

  private extensionVersion(): string {
    const version = this.context.extension.packageJSON?.version;
    return typeof version === "string" && version ? version : "0.0.0";
  }

  private registerViews(): void {
    this.context.subscriptions.push(
      vscode.window.createTreeView("salesforceEca.orgs", {
        treeDataProvider: this.orgsProvider,
        showCollapseAll: false
      }),
      vscode.window.createTreeView("salesforceEca.ecas", {
        treeDataProvider: this.ecaProvider,
        showCollapseAll: false
      }),
      vscode.window.createTreeView("salesforceEca.audit", {
        treeDataProvider: this.auditProvider,
        showCollapseAll: false
      })
    );
  }

  private registerCommands(): void {
    const register = (id: string, handler: (...args: unknown[]) => unknown): void => {
      this.context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    };

    register("salesforceEca.selectOrg", (argument?: unknown) => this.selectOrgCommand(argument));
    register("salesforceEca.refreshOrgs", () => this.refreshOrgs());
    register("salesforceEca.refreshEcas", () => this.refreshEcas());
    register("salesforceEca.rotateCredentials", (argument?: unknown) => this.rotateCommand(argument));
    register("salesforceEca.stageCredentials", (argument?: unknown) => this.stageCommand(argument));
    register("salesforceEca.retrieveCredentials", (argument?: unknown) => this.retrieveCommand(argument));
    register("salesforceEca.copyClientId", () => this.copyHeldCredential("clientId"));
    register("salesforceEca.copyClientSecret", () => this.copyHeldCredential("clientSecret"));
    register("salesforceEca.clearCredentials", () => this.clearCredentialsCommand());
    register("salesforceEca.validateCredentials", () => this.validateCredentialsCommand());
    register("salesforceEca.deleteStagedCredential", (argument?: unknown) =>
      this.deleteStagedCommand(argument)
    );
    register("salesforceEca.showEcaDetails", (argument?: unknown) => this.showEcaDetails(argument));
    register("salesforceEca.openSetup", (argument?: unknown) => this.openSetupCommand(argument));
    register("salesforceEca.openAudit", (argument?: unknown) => this.openAuditCommand(argument));
    register("salesforceEca.openAuditRecord", (argument?: unknown) => this.openAuditRecordCommand(argument));
    register("salesforceEca.refreshAudit", () => this.refreshAudit());
    register("salesforceEca.openSettings", () => this.openSettingsCommand());
    register("salesforceEca.copyLoginCommand", (argument?: unknown) => this.copyLoginCommand(argument));
  }

  private registerListeners(): void {
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("salesforceEca")) {
          return;
        }
        this.settings = readSettings();
        this.buildServices(this.settings);
        this.logger.info("Extension settings were reloaded.");
        this.updateStatusBar();
        void this.refreshAudit({ silent: true });
      }),
      this.credentials.addListener(() => {
        this.updateContextKeys();
        this.updateStatusBar();
        this.ecaProvider.refresh();
      })
    );
  }

  private restoreSelectedOrg(): void {
    const stored = deserializeOrg(this.context.workspaceState.get<unknown>(SELECTED_ORG_KEY));
    if (stored) {
      this.state.setSelectedOrg(stored, false);
    }
  }

  private async startup(): Promise<void> {
    await this.refreshOrgs({ silent: true });
    await this.refreshAudit({ silent: true });

    const org = this.state.selectedOrg;
    if (org && this.state.selectedOrgAvailable && org.status === "connected") {
      await this.refreshEcas({ silent: true });
    }
  }

  private async selectOrgCommand(argument?: unknown): Promise<void> {
    if (isSalesforceOrg(argument)) {
      const match = this.state.orgs.find((org) => sameOrg(org, argument));
      await this.selectOrg(match ?? argument);
      return;
    }
    const picked = await this.pickOrg("Select Salesforce Org");
    if (picked) {
      await this.selectOrg(picked);
    }
  }

  private async pickOrg(title: string): Promise<SalesforceOrg | undefined> {
    if (this.state.orgs.length === 0) {
      const choice = await vscode.window.showWarningMessage(
        "No Salesforce orgs are available. Sign in with the Salesforce CLI, then refresh.",
        "Refresh Orgs"
      );
      if (choice === "Refresh Orgs") {
        await this.refreshOrgs();
      }
      return undefined;
    }

    const picked = await vscode.window.showQuickPick(
      this.state.orgs.map((org) => ({
        label: `${this.state.isSelectedOrg(org) ? "$(check) " : ""}${org.alias ?? org.username}`,
        description: `${org.environment} • ${connectionLabel(org)}`,
        detail: org.instanceUrl,
        org
      })),
      {
        title,
        placeHolder: "Select the org to work with. The extension never switches orgs automatically.",
        matchOnDescription: true,
        matchOnDetail: true
      }
    );
    return picked?.org;
  }

  private async selectOrg(org: SalesforceOrg): Promise<void> {
    const match = this.state.orgs.find((candidate) => sameOrg(candidate, org));
    const available = Boolean(match);
    const next = match ?? org;
    const changed = !this.state.selectedOrg || !sameOrg(this.state.selectedOrg, next);

    if (changed) {
      this.state.clearEcas();
      this.credentials.clear();
    }
    this.state.setSelectedOrg(next, available);
    void this.persistSelectedOrg(next);
    this.orgsProvider.refresh();
    this.ecaProvider.refresh();
    this.updateContextKeys();
    this.updateStatusBar();

    if (!available) {
      const choice = await vscode.window.showWarningMessage(
        `${next.alias ?? next.username} is no longer available in the Salesforce CLI. Select or re-authenticate an org.`,
        "Refresh Orgs"
      );
      if (choice === "Refresh Orgs") {
        await this.refreshOrgs();
      }
      return;
    }

    if (next.status === "expired" || next.status === "unreachable") {
      const choice = await vscode.window.showWarningMessage(
        `${connectionLabel(next)}: the Salesforce CLI session for ${next.alias ?? next.username} needs attention. ` +
          "Re-authenticate before rotating credentials.",
        "Copy Login Command"
      );
      if (choice === "Copy Login Command") {
        await this.copyLoginCommandFor(next);
      }
      return;
    }

    await this.refreshEcas();
  }

  private async refreshOrgs(options: { silent?: boolean } = {}): Promise<void> {
    const silent = options.silent === true;
    this.state.orgsLoading = true;
    this.state.orgsError = undefined;
    this.orgsProvider.refresh();

    try {
      const result = await this.services.orgs.listOrgs();
      this.state.orgs = result.orgs;
      for (const warning of result.warnings) {
        this.logger.warn(warning);
      }
      this.reconcileSelectedOrg();
    } catch (error) {
      const appError = toAppError(error, "Could not load Salesforce orgs from the CLI.");
      this.state.orgsError = appError.userMessage;
      this.logger.error("Could not load Salesforce orgs.", error);
      if (!silent) {
        await this.showError(error, "Could not load Salesforce orgs from the CLI.");
      }
    } finally {
      this.state.orgsLoading = false;
      this.orgsProvider.refresh();
      this.updateContextKeys();
      this.updateStatusBar();
    }
  }

  private reconcileSelectedOrg(): void {
    const current = this.state.selectedOrg;
    if (!current) {
      return;
    }
    const match = this.state.orgs.find((org) => sameOrg(org, current));
    if (match) {
      this.state.setSelectedOrg(match, true);
      void this.persistSelectedOrg(match);
    } else {
      this.state.setSelectedOrg(current, false);
    }
  }

  private async refreshEcas(options: { silent?: boolean } = {}): Promise<void> {
    if (this.refreshingEcas) {
      await this.refreshingEcas;
      return;
    }
    this.refreshingEcas = this.runEcaRefresh(options.silent === true).finally(() => {
      this.refreshingEcas = undefined;
    });
    await this.refreshingEcas;
  }

  private async runEcaRefresh(silent: boolean): Promise<void> {
    const org = this.state.selectedOrg;
    if (!org) {
      if (!silent) {
        void vscode.window.showWarningMessage("Select a Salesforce org before refreshing External Client Apps.");
      }
      return;
    }
    if (!this.state.selectedOrgAvailable) {
      if (!silent) {
        void vscode.window.showWarningMessage(
          "The selected org is no longer available in the Salesforce CLI. Select or re-authenticate an org."
        );
      }
      return;
    }

    this.state.ecasLoading = true;
    this.state.ecasError = undefined;
    this.ecaProvider.refresh();
    this.updateStatusBar();

    try {
      const session = await this.services.orgs.assertSession(org);
      const api = this.createApi(session);
      const result = await api.listEcas(org.alias);
      this.state.setEcas(result.ecas);
      for (const warning of result.warnings) {
        this.logger.warn(warning);
      }
      this.logger.info(`Loaded ${result.ecas.length} External Client App(s) for ${org.alias ?? org.username}.`);
    } catch (error) {
      const appError = toAppError(error, "Could not discover External Client Apps.");
      this.state.ecasError = appError.userMessage;
      this.logger.error("Could not discover External Client Apps.", error);
      if (isAuthError(error)) {
        this.markSelectedOrgExpired();
      }
      if (!silent) {
        await this.showError(error, "Could not discover External Client Apps.");
      }
    } finally {
      this.state.ecasLoading = false;
      this.ecaProvider.refresh();
      this.updateStatusBar();
    }
  }

  private markSelectedOrgExpired(): void {
    const current = this.state.selectedOrg;
    if (!current) {
      return;
    }
    const updated: SalesforceOrg = {
      ...current,
      status: "expired",
      connectedStatus: current.connectedStatus ?? "Session expired"
    };
    this.state.setSelectedOrg(updated, true);
    this.state.orgs = this.state.orgs.map((org) =>
      sameOrg(org, updated)
        ? { ...org, status: "expired", connectedStatus: updated.connectedStatus }
        : org
    );
    this.orgsProvider.refresh();
    this.updateStatusBar();
    void this.persistSelectedOrg(updated);
  }

  private async rotateCommand(argument?: unknown): Promise<void> {
    const eca = await this.ensureEca(argument);
    if (eca) {
      await this.openWizard("full", eca);
    }
  }

  private async stageCommand(argument?: unknown): Promise<void> {
    const eca = await this.ensureEca(argument);
    if (eca) {
      await this.openWizard("stage", eca);
    }
  }

  private async retrieveCommand(argument?: unknown): Promise<void> {
    const eca = await this.ensureEca(argument);
    if (eca) {
      await this.openWizard("retrieve", eca);
    }
  }

  private async ensureEca(argument?: unknown): Promise<Eca | undefined> {
    let eca: Eca | undefined;
    if (isEca(argument)) {
      eca = this.state.findEca(argument) ?? argument;
    } else {
      eca = this.state.selectedEca;
    }

    if (!eca) {
      if (this.state.ecas.length === 0) {
        const choice = await vscode.window.showWarningMessage(
          "No External Client Apps are loaded for the selected org.",
          "Refresh External Client Apps"
        );
        if (choice === "Refresh External Client Apps") {
          await this.refreshEcas();
        }
      }

      if (this.state.ecas.length > 0) {
        const picked = await vscode.window.showQuickPick(
          this.state.ecas.map((candidate) => ({
            label: candidate.name,
            description: `${candidate.supported ? "Supported" : "Unsupported"} • ${candidate.developerName}`,
            detail: candidate.supported
              ? `Consumer ${candidate.consumer?.id ?? "not available"}`
              : candidate.unsupportedReason ?? "Not eligible for rotation",
            candidate
          })),
          {
            title: "Select an External Client App",
            placeHolder: "Only local External Client Apps with an accessible OAuth consumer can be rotated.",
            matchOnDescription: true,
            matchOnDetail: true
          }
        );
        eca = picked?.candidate;
      }
    }

    if (!eca) {
      return undefined;
    }

    if (!hasSupportedEca(eca)) {
      void vscode.window.showWarningMessage(
        eca.unsupportedReason ??
          "This External Client App is not eligible for credential rotation in this extension."
      );
      return undefined;
    }

    this.setSelectedEca(eca);
    return eca;
  }

  private setSelectedEca(eca: Eca): void {
    const current = this.state.selectedEca;
    const sameEca =
      Boolean(current) &&
      current?.identifier === eca.identifier &&
      current?.consumer?.id === eca.consumer?.id;

    if (!sameEca) {
      const scope = this.credentials.scope;
      if (scope && (scope.appIdentifier !== eca.identifier || scope.consumerId !== eca.consumer?.id)) {
        this.credentials.clear();
      }
    }

    this.state.selectedEca = eca;
    this.ecaProvider.refresh();
    this.updateStatusBar();
  }

  private async openWizard(intent: WizardIntent, eca: Eca): Promise<void> {
    const org = this.requireSelectedOrg();
    if (!org) {
      return;
    }

    try {
      RotationWizard.show({
        org,
        eca,
        intent,
        rotation: this.services.rotation,
        credentials: this.credentials,
        clipboard: this.clipboard,
        logger: this.logger,
        extensionUri: this.context.extensionUri,
        auditFilePath: () => this.services.audit.filePath,
        isOrgStillSelected: (candidate) =>
          Boolean(
            this.state.selectedOrg &&
              this.state.selectedOrgAvailable &&
              sameOrg(this.state.selectedOrg, candidate)
          ),
        onChanged: async () => {
          await this.refreshAudit({ silent: true });
          this.ecaProvider.refresh();
          this.updateStatusBar();
        },
        onOpenAudit: (path) => this.openAuditFile(path),
        onOpenSetup: () => this.openSetupFor(org)
      });
    } catch (error) {
      await this.showError(error, "The credential rotation wizard could not be opened.");
    }
  }

  private requireSelectedOrg(): SalesforceOrg | undefined {
    const org = this.state.selectedOrg;
    if (!org) {
      void vscode.window.showWarningMessage("Select a Salesforce org first.");
      return undefined;
    }
    if (!this.state.selectedOrgAvailable) {
      void vscode.window.showWarningMessage(
        "The selected org is no longer available in the Salesforce CLI. Select or re-authenticate an org."
      );
      return undefined;
    }
    return org;
  }

  private getHeldCredential(): StagedCredentialSecret | undefined {
    const scope = this.credentials.scope;
    return scope ? this.credentials.get(scope) : undefined;
  }

  private async copyHeldCredential(field: "clientId" | "clientSecret"): Promise<void> {
    const held = this.getHeldCredential();
    if (!held) {
      const choice = await vscode.window.showWarningMessage(
        "No client credentials are held in memory. Retrieve staged credentials first.",
        "Retrieve Credentials"
      );
      if (choice === "Retrieve Credentials") {
        await this.retrieveCommand();
      }
      return;
    }
    if (field === "clientId") {
      await this.clipboard.copy("Client ID", held.clientId);
    } else {
      await this.clipboard.copy("Client secret", held.clientSecret);
    }
  }

  private clearCredentialsCommand(): void {
    this.credentials.clear();
    void vscode.window.showInformationMessage(
      "Credentials were cleared from extension memory. Clipboard contents are unchanged."
    );
  }

  private async validateCredentialsCommand(): Promise<void> {
    const held = this.getHeldCredential();
    if (!held) {
      const choice = await vscode.window.showWarningMessage(
        "No new credentials are held in memory. Retrieve the staged credentials before validating them.",
        "Retrieve Credentials"
      );
      if (choice === "Retrieve Credentials") {
        await this.retrieveCommand();
      }
      return;
    }

    const org = this.requireSelectedOrg();
    if (!org) {
      return;
    }
    const scope = this.credentials.scope;
    if (!scope || !this.scopeMatchesOrg(scope, org)) {
      const choice = await vscode.window.showWarningMessage(
        "The credentials held in memory belong to a different Salesforce org. Clear them and retrieve the intended credentials.",
        "Clear Credentials"
      );
      if (choice === "Clear Credentials") {
        this.clearCredentialsCommand();
      }
      return;
    }

    let eca = this.state.ecas.find(
      (candidate) =>
        candidate.identifier === scope.appIdentifier && candidate.consumer?.id === scope.consumerId
    );
    if (!eca) {
      await this.refreshEcas({ silent: true });
      eca = this.state.ecas.find(
        (candidate) =>
          candidate.identifier === scope.appIdentifier && candidate.consumer?.id === scope.consumerId
      );
    }
    if (!eca) {
      void vscode.window.showWarningMessage(
        "The External Client App for the held credentials is not available. Refresh External Client Apps and try again."
      );
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      "Run optional OAuth Client Credentials validation?",
      {
        modal: true,
        detail: [
          `Org: ${org.alias ?? org.username} (${org.environment})`,
          `External Client App: ${eca.developerName}`,
          "",
          "This sends a Client Credentials OAuth token request with the new client ID and secret.",
          "Only proceed if Client Credentials Flow is enabled and a Run-As user is assigned.",
          "The issued access token is discarded and is never displayed or logged."
        ].join("\n")
      },
      "Run Validation"
    );
    if (confirmed !== "Run Validation") {
      return;
    }

    try {
      const result = await this.services.rotation.validateIntegration(
        org,
        eca,
        held.stagedCredentialId,
        { confirmed: true }
      );
      await this.refreshAudit({ silent: true });
      if (result.ok) {
        void vscode.window.showInformationMessage(
          `OAuth Client Credentials validation succeeded. ${result.detail} The access token was discarded.`
        );
      } else {
        void vscode.window.showWarningMessage(
          `OAuth Client Credentials validation did not succeed. ${result.detail}`
        );
      }
    } catch (error) {
      await this.showError(error, "The optional integration validation did not complete.");
    }
  }

  private scopeMatchesOrg(scope: CredentialScope, org: SalesforceOrg): boolean {
    if (scope.orgId && org.orgId) {
      return scope.orgId === org.orgId;
    }
    return scope.orgUsername.toLowerCase() === org.username.toLowerCase();
  }

  private async deleteStagedCommand(argument?: unknown): Promise<void> {
    const eca = await this.ensureEca(argument);
    if (!eca) {
      return;
    }
    const org = this.requireSelectedOrg();
    if (!org) {
      return;
    }

    try {
      const preflight = await this.services.rotation.preflight(org, eca);
      const candidates = preflight.existingStaged.filter(
        (entry) => entry.state === "active" || entry.state === "rotated"
      );
      if (candidates.length === 0) {
        void vscode.window.showInformationMessage(
          "No staged credential is available to delete for this External Client App."
        );
        return;
      }

      let target = candidates[0];
      if (candidates.length > 1) {
        const picked = await vscode.window.showQuickPick(
          candidates.map((entry) => ({
            label: `${entry.state === "active" ? "Active" : "Rotated"} staged credential`,
            description: entry.id,
            detail: entry.expirationDate
              ? `Expires ${new Date(entry.expirationDate).toLocaleString()}`
              : "Expiration not reported",
            entry
          })),
          {
            title: "Select the staged credential to delete",
            placeHolder: "Deleting a staged credential does not change the active consumer credentials."
          }
        );
        if (!picked) {
          return;
        }
        target = picked.entry;
      }

      const confirmed = await vscode.window.showWarningMessage(
        "Delete the staged credential?",
        {
          modal: true,
          detail: [
            `Org: ${org.alias ?? org.username} (${org.environment})`,
            `External Client App: ${eca.developerName}`,
            `Staged credential: ${target.id}`,
            "",
            "The additional staged credential set is removed. The active consumer credentials are not changed."
          ].join("\n")
        },
        "Delete Staged Credential"
      );
      if (confirmed !== "Delete Staged Credential") {
        return;
      }

      await this.services.rotation.deleteStagedCredential(org, eca, target.id, { confirmed: true });
      await this.refreshAudit({ silent: true });
      this.updateStatusBar();
      void vscode.window.showInformationMessage("The staged credential was deleted.");
    } catch (error) {
      await this.showError(error, "The staged credential could not be deleted.");
    }
  }

  private async showEcaDetails(argument?: unknown): Promise<void> {
    const eca = isEca(argument)
      ? this.state.findEca(argument) ?? argument
      : this.state.selectedEca;
    if (!eca) {
      return;
    }
    this.setSelectedEca(eca);

    const detail = [
      `API name: ${eca.developerName}`,
      `Identifier: ${eca.identifier}`,
      `Consumer ID: ${eca.consumer?.id ?? "not available"}`,
      `Current client ID: ${maskCredential(eca.consumer?.key)}`,
      `Distribution: ${eca.isFromPackage ? "Packaged" : "Local"}`,
      eca.supported
        ? "Rotation: supported (administrator approval required)"
        : `Rotation: unsupported — ${eca.unsupportedReason ?? "not eligible"}`,
      `Org: ${eca.orgAlias ?? eca.orgUsername}`
    ].join("\n");

    const actions = eca.supported ? ["Rotate Credentials…", "Open Setup"] : ["Open Setup"];
    const choice = await vscode.window.showInformationMessage(eca.name, { detail }, ...actions);
    if (choice === "Rotate Credentials…") {
      await this.openWizard("full", eca);
    } else if (choice === "Open Setup") {
      await this.openSetupFor(this.state.selectedOrg);
    }
  }

  private async openSetupCommand(argument?: unknown): Promise<void> {
    const org = this.state.selectedOrg;
    if (!org) {
      void vscode.window.showWarningMessage("Select a Salesforce org first.");
      return;
    }
    if (isEca(argument)) {
      this.setSelectedEca(argument);
    }
    await this.openSetupFor(org);
  }

  private async openSetupFor(org: SalesforceOrg | undefined): Promise<void> {
    if (!org) {
      void vscode.window.showWarningMessage("Select a Salesforce org first.");
      return;
    }
    try {
      const baseUrl = assertSalesforceInstanceUrl(org.instanceUrl);
      await vscode.env.openExternal(
        vscode.Uri.parse(`${baseUrl}/lightning/setup/ExternalClientApps/home`)
      );
    } catch (error) {
      await this.showError(error, "The External Client Apps Setup page could not be opened.");
    }
  }

  private async openAuditCommand(argument?: unknown): Promise<void> {
    await this.openAuditFile(typeof argument === "string" ? argument : undefined);
  }

  private async openAuditFile(file?: string): Promise<void> {
    const target = file ?? this.services.audit.filePath;
    try {
      await fs.access(target);
    } catch {
      void vscode.window.showInformationMessage(
        "No rotation audit records have been written yet. Successful and failed operations are appended automatically."
      );
      return;
    }
    try {
      await this.openFileAtLine(target, 1);
    } catch (error) {
      await this.showError(error, "The audit file could not be opened.");
    }
  }

  private async openAuditRecordCommand(argument?: unknown): Promise<void> {
    let entry = isAuditEntry(argument) ? argument : undefined;
    if (!entry) {
      if (this.state.auditEntries.length === 0) {
        await this.refreshAudit({ silent: true });
      }
      if (this.state.auditEntries.length === 0) {
        void vscode.window.showInformationMessage("No rotation audit records are available.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        this.state.auditEntries.map((candidate) => ({
          label: `${candidate.record.eca.developerName}: ${candidate.record.outcome}`,
          description: `${new Date(candidate.record.timestamp).toLocaleString()} • ${
            candidate.record.org.alias ?? candidate.record.org.username
          }`,
          detail: `Audit ID ${candidate.record.auditId}`,
          candidate
        })),
        {
          title: "Open Rotation Audit Record",
          placeHolder: "Select an audit record to reveal in the audit file.",
          matchOnDescription: true,
          matchOnDetail: true
        }
      );
      entry = picked?.candidate;
    }

    if (!entry) {
      return;
    }
    try {
      await this.openFileAtLine(entry.filePath, entry.line);
    } catch (error) {
      await this.showError(error, "The audit record could not be opened.");
    }
  }

  private async openFileAtLine(file: string, line: number): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const index = Math.max(0, Math.min(line - 1, document.lineCount - 1));
    const position = new vscode.Position(index, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenter
    );
  }

  private async refreshAudit(options: { silent?: boolean } = {}): Promise<void> {
    const silent = options.silent === true;
    this.state.auditLoading = true;
    this.state.auditError = undefined;
    this.auditProvider.refresh();

    try {
      this.state.auditEntries = await this.services.audit.readRecent(MAX_AUDIT_ENTRIES);
    } catch (error) {
      const appError = toAppError(error, "Could not read the rotation audit file.");
      this.state.auditError = appError.userMessage;
      this.logger.error("Could not read the rotation audit file.", error);
      if (!silent) {
        await this.showError(error, "Could not read the rotation audit file.");
      }
    } finally {
      this.state.auditLoading = false;
      this.auditProvider.refresh();
    }
  }

  private async openSettingsCommand(): Promise<void> {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      `@ext:${this.context.extension.id}`
    );
  }

  private async copyLoginCommand(argument?: unknown): Promise<void> {
    let org = isSalesforceOrg(argument) ? argument : this.state.selectedOrg;
    if (!org) {
      org = await this.pickOrg("Copy Salesforce CLI Login Command");
    }
    if (!org) {
      return;
    }
    await this.copyLoginCommandFor(org);
  }

  private async copyLoginCommandFor(org: SalesforceOrg): Promise<void> {
    const reference = org.alias?.trim() || org.username;
    const parts = ["sf", "org", "login", "web", "--alias", quoteShellArgument(reference)];
    if (org.isSandbox) {
      parts.push("--instance-url", "https://test.salesforce.com");
    }
    await this.clipboard.copyWithoutCredentialWarning(
      "Salesforce CLI login command",
      parts.join(" ")
    );
  }

  private async showError(error: unknown, fallbackMessage: string): Promise<void> {
    const appError = toAppError(error, fallbackMessage);
    const actions: string[] = ["Show Output"];
    if (isAuthError(error) && this.state.selectedOrg) {
      actions.push("Copy Login Command");
    }
    const choice = await vscode.window.showErrorMessage(appError.userMessage, ...actions);
    if (choice === "Show Output") {
      this.logger.show();
    } else if (choice === "Copy Login Command" && this.state.selectedOrg) {
      await this.copyLoginCommandFor(this.state.selectedOrg);
    }
  }

  private updateContextKeys(): void {
    void vscode.commands.executeCommand(
      "setContext",
      "salesforceEca.hasSelectedOrg",
      Boolean(this.state.selectedOrg && this.state.selectedOrgAvailable)
    );
    void vscode.commands.executeCommand(
      "setContext",
      "salesforceEca.hasCredentialSession",
      this.credentials.has()
    );
  }

  private updateStatusBar(): void {
    const org = this.state.selectedOrg;
    const held = this.getHeldCredential();
    const parts = [this.state.ecasLoading ? "$(sync~spin)" : "$(account)"];

    if (!org) {
      parts.push("Select Salesforce Org");
    } else {
      parts.push(org.alias ?? org.username);
      if (held) {
        parts.push("$(lock)");
      }
    }

    this.statusBar.text = parts.join(" ");
    const tooltip = new vscode.MarkdownString();
    if (!org) {
      tooltip.appendText("No Salesforce org is selected. Click to select one.");
    } else {
      tooltip.appendMarkdown(`**${org.alias ?? org.username}**\n\n`);
      tooltip.appendText(`Environment: ${org.environment}\n`);
      tooltip.appendText(`CLI status: ${connectionLabel(org)}\n`);
      tooltip.appendText(`Instance: ${org.instanceUrl}\n`);
      if (!this.state.selectedOrgAvailable) {
        tooltip.appendText("This org is no longer present in the Salesforce CLI list.\n");
      }
      if (this.state.selectedEca) {
        tooltip.appendText(`External Client App: ${this.state.selectedEca.developerName}\n`);
      }
    }
    if (held) {
      const expiresAt = this.credentials.expiresAt;
      tooltip.appendText(
        expiresAt
          ? `Credentials are held in memory until ${new Date(expiresAt).toLocaleTimeString()}.\n`
          : "Credentials are held in memory.\n"
      );
    } else {
      tooltip.appendText("No credentials are held in memory.\n");
    }
    this.statusBar.tooltip = tooltip;
    this.statusBar.command = "salesforceEca.selectOrg";
    this.statusBar.backgroundColor =
      org && (org.status === "expired" || org.status === "unreachable" || !this.state.selectedOrgAvailable)
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
    this.statusBar.show();
  }

  private async persistSelectedOrg(org: SalesforceOrg | undefined): Promise<void> {
    try {
      await this.context.workspaceState.update(
        SELECTED_ORG_KEY,
        org ? serializeOrg(org) : undefined
      );
    } catch (error) {
      this.logger.warn(`Could not persist the selected org: ${String(error)}`);
    }
  }
}
