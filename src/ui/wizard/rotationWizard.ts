import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { AppError, toAppError } from "../../core/errors";
import { errorSummary, type Logger } from "../../core/logger";
import type { CredentialSession } from "../../core/credentials/credentialSession";
import { RotationFailedError, type RotationService } from "../../core/rotation/rotationService";
import type {
  Eca,
  IntegrationValidationResult,
  PreflightCheck,
  SalesforceOrg,
  StagedCredentialInfo,
  StagedCredentialSecret
} from "../../core/types";
import type { ClipboardService } from "../clipboard";
import { buildWizardHtml } from "./wizardHtml";
import {
  orgView,
  type WizardIntent,
  type WizardResultView,
  type WizardStep,
  type WizardViewModel
} from "./wizardTypes";

export interface RotationWizardDependencies {
  org: SalesforceOrg;
  eca: Eca;
  intent: WizardIntent;
  rotation: RotationService;
  credentials: CredentialSession;
  clipboard: ClipboardService;
  logger: Logger;
  extensionUri: vscode.Uri;
  auditFilePath: () => string;
  isOrgStillSelected: (org: SalesforceOrg) => boolean;
  onChanged: () => Promise<void> | void;
  onOpenAudit: (path?: string) => Promise<void>;
  onOpenSetup: () => Promise<void>;
}

const REVEAL_TIMEOUT_MS = 60_000;

export class RotationWizard {
  private static current: RotationWizard | undefined;

  static show(dependencies: RotationWizardDependencies): RotationWizard {
    RotationWizard.current?.close();
    const wizard = new RotationWizard(dependencies);
    RotationWizard.current = wizard;
    return wizard;
  }

  private readonly dependencies: RotationWizardDependencies;
  private readonly panel: vscode.WebviewPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly scope: {
    orgId?: string;
    orgUsername: string;
    appIdentifier: string;
    consumerId: string;
  };

  private disposed = false;
  private busy = false;
  private step: WizardStep = "preflight";
  private intent: WizardIntent;
  private preflight?: {
    checks: PreflightCheck[];
    canStage: boolean;
    apiVersion: string;
    existingStaged: StagedCredentialInfo[];
  };
  private staged?: StagedCredentialInfo;
  private checklistAcknowledged = false;
  private revealed = false;
  private result?: WizardResultView;
  private validation?: IntegrationValidationResult;
  private error?: { message: string; auditId?: string; auditPath?: string };
  private notice?: string;
  private revealTimer?: NodeJS.Timeout;
  private lastViewModel?: WizardViewModel;

  private constructor(dependencies: RotationWizardDependencies) {
    this.dependencies = dependencies;
    this.intent = dependencies.intent;
    const consumer = dependencies.eca.consumer;
    if (!consumer) {
      throw new AppError({
        code: "UNSUPPORTED",
        userMessage: "This External Client App has no OAuth consumer and cannot be managed by this wizard."
      });
    }
    this.scope = {
      orgId: dependencies.org.orgId,
      orgUsername: dependencies.org.username,
      appIdentifier: dependencies.eca.identifier,
      consumerId: consumer.id
    };

    const mediaRoot = vscode.Uri.joinPath(dependencies.extensionUri, "media");
    this.panel = vscode.window.createWebviewPanel(
      "salesforceEca.rotationWizard",
      `Rotate: ${dependencies.eca.developerName}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [mediaRoot]
      }
    );
    this.panel.iconPath = vscode.Uri.joinPath(mediaRoot, "eca.svg");

    const nonce = createNonce();
    this.panel.webview.html = buildWizardHtml({
      cspSource: this.panel.webview.cspSource,
      nonce,
      scriptUri: this.panel.webview.asWebviewUri(
        vscode.Uri.joinPath(mediaRoot, "wizard.js")
      ).toString(),
      styleUri: this.panel.webview.asWebviewUri(
        vscode.Uri.joinPath(mediaRoot, "wizard.css")
      ).toString()
    });

    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        void this.handleMessage(message);
      },
      undefined,
      this.subscriptions
    );
    this.panel.onDidDispose(
      () => {
        this.dispose();
      },
      undefined,
      this.subscriptions
    );

    this.subscriptions.push(
      dependencies.credentials.addListener(() => {
        if (this.disposed) {
          return;
        }
        if (this.step === "retrieved" && !this.getHeldCredential()) {
          this.revealed = false;
          this.step = "staged";
          this.notice = "Credentials were cleared or expired and are no longer held in memory.";
        }
        this.postState();
      })
    );

    this.panel.reveal(vscode.ViewColumn.Active);
    void this.runPreflight();
  }

  close(): void {
    if (!this.disposed) {
      this.panel.dispose();
    }
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearRevealTimer();
    this.dependencies.credentials.clear();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    if (RotationWizard.current === this) {
      RotationWizard.current = undefined;
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (this.disposed || !message || typeof message !== "object") {
      return;
    }
    const data = message as Record<string, unknown>;
    switch (data.type) {
      case "ready":
        if (this.lastViewModel) {
          void this.postState();
        }
        break;
      case "runChecks":
        await this.runPreflight();
        break;
      case "stage":
        await this.stage();
        break;
      case "retrieve":
        await this.retrieve();
        break;
      case "revealSecret":
        this.revealSecret();
        break;
      case "hideSecret":
        this.revealed = false;
        this.clearRevealTimer();
        this.postState();
        break;
      case "clearCredentials":
        this.clearCredentials();
        break;
      case "copy":
        await this.copy(data.field);
        break;
      case "checklistComplete": {
        const acknowledged = data.acknowledged === true;
        this.checklistAcknowledged = acknowledged;
        this.step = acknowledged ? "approval" : "checklist";
        this.error = undefined;
        this.postState();
        break;
      }
      case "openChecklist":
        this.checklistAcknowledged = false;
        this.step = "checklist";
        this.error = undefined;
        this.notice = "Complete every integration update item before approving rotation.";
        this.postState();
        break;
      case "backTo": {
        const target = data.step;
        if (target === "preflight") {
          await this.runPreflight();
        } else if (target === "staged" && this.staged) {
          this.step = "staged";
          this.error = undefined;
          this.postState();
        } else if (target === "retrieved" && this.getHeldCredential()) {
          this.step = "retrieved";
          this.error = undefined;
          this.postState();
        } else if (target === "checklist") {
          this.step = "checklist";
          this.error = undefined;
          this.postState();
        } else if (target === "approval") {
          this.step = "approval";
          this.error = undefined;
          this.postState();
        }
        break;
      }
      case "rotate":
        await this.rotate(
          typeof data.typedEcaName === "string" ? data.typedEcaName : "",
          data.checklistAcknowledged === true
        );
        break;
      case "validate":
        await this.validate();
        break;
      case "deleteStaged":
        await this.deleteStaged();
        break;
      case "openAudit":
        await this.dependencies.onOpenAudit(
          this.result?.auditPath ?? this.error?.auditPath ?? this.dependencies.auditFilePath()
        );
        break;
      case "openSetup":
        await this.dependencies.onOpenSetup();
        break;
      case "restart":
        await this.restart();
        break;
      case "close":
        this.close();
        break;
      default:
        break;
    }
  }

  private async runPreflight(): Promise<void> {
    await this.perform(async () => {
      await this.loadPreflight();
    });
  }

  private async loadPreflight(): Promise<void> {
    this.error = undefined;
    this.notice = undefined;
    this.preflight = await this.dependencies.rotation.preflight(
      this.dependencies.org,
      this.dependencies.eca
    );
    if (this.intent === "retrieve" && !this.staged && this.preflight.existingStaged.length > 0) {
      this.staged = this.preflight.existingStaged[0];
      this.step = "staged";
    } else {
      this.step = "preflight";
    }
  }

  private async stage(): Promise<void> {
    await this.perform(async () => {
      if (!this.preflight) {
        await this.loadPreflight();
      }
      if (!this.preflight?.canStage) {
        throw new AppError({
          code: "VALIDATION",
          userMessage: "Resolve the failed pre-rotation checks before staging credentials."
        });
      }
      const existingActive = this.preflight.existingStaged.some((entry) => entry.state === "active");
      const confirmed = await this.confirmWarning(
        `Stage new OAuth credentials for ${this.dependencies.eca.name}?`,
        [
          `Org: ${this.orgLabel()}`,
          `External Client App: ${this.dependencies.eca.developerName}`,
          "",
          "Staging creates an additional credential that can authenticate immediately. It does not rotate or revoke the current credential.",
          existingActive
            ? "An active staged credential already exists. Continuing replaces it."
            : "You will retrieve and copy the new values before any rotation."
        ].join("\n"),
        "Stage Credentials"
      );
      if (!confirmed) {
        return;
      }
      if (this.disposed) {
        return;
      }
      const result = await this.dependencies.rotation.stage(
        this.dependencies.org,
        this.dependencies.eca,
        { acknowledgeExistingStaged: existingActive }
      );
      this.staged = result.staged;
      this.preflight = {
        ...this.preflight,
        existingStaged: [
          result.staged,
          ...this.preflight.existingStaged.filter((entry) => entry.id !== result.staged.id)
        ]
      };
      this.step = "staged";
      this.notice = "New credentials are staged and active. Rotate only after updating your integrations.";
      this.error = undefined;
      await this.notifyChanged();
    });
  }

  private async retrieve(): Promise<void> {
    await this.perform(async () => {
      const stagedId = await this.resolveStagedId();
      if (!stagedId) {
        throw new AppError({
          code: "VALIDATION",
          userMessage: "No staged credential is available to retrieve. Stage new credentials first."
        });
      }
      const confirmed = await this.confirmWarning(
        "Retrieve staged client ID and secret?",
        [
          `Org: ${this.orgLabel()}`,
          `External Client App: ${this.dependencies.eca.developerName}`,
          "",
          "The values will be displayed in this panel and held in extension memory only. They are never logged, written to disk, or included in audit records.",
          "The secret remains masked until you explicitly reveal it."
        ].join("\n"),
        "Retrieve Credentials"
      );
      if (!confirmed) {
        return;
      }
      if (this.disposed) {
        return;
      }
      const retrieved = await this.dependencies.rotation.retrieve(
        this.dependencies.org,
        this.dependencies.eca,
        stagedId,
        { explicit: true }
      );
      this.staged = retrieved.staged;
      this.revealed = false;
      this.step = "retrieved";
      this.notice = "Credentials retrieved. Copy them now or continue to the integration checklist.";
      this.error = undefined;
      await this.notifyChanged();
    });
  }

  private async copy(field: unknown): Promise<void> {
    const held = this.getHeldCredential();
    if (!held) {
      this.error = { message: "No retrieved credentials are held in memory. Retrieve them again." };
      this.postState();
      return;
    }
    if (field === "clientId") {
      await this.dependencies.clipboard.copy("Client ID", held.clientId);
    } else if (field === "clientSecret") {
      await this.dependencies.clipboard.copy("Client secret", held.clientSecret);
    }
  }

  private revealSecret(): void {
    const held = this.getHeldCredential();
    if (!held) {
      this.error = { message: "No retrieved credentials are held in memory. Retrieve them again." };
      this.postState();
      return;
    }
    this.revealed = true;
    this.clearRevealTimer();
    this.revealTimer = setTimeout(() => {
      this.revealed = false;
      this.postState();
    }, REVEAL_TIMEOUT_MS);
    this.revealTimer.unref?.();
    this.postState();
  }

  private clearCredentials(): void {
    this.dependencies.credentials.clear();
    this.revealed = false;
    this.clearRevealTimer();
    if (this.step === "retrieved") {
      this.step = "staged";
    }
    this.notice = "Credentials were cleared from extension memory.";
    this.postState();
  }

  private async rotate(typedEcaName: string, checklistAcknowledged: boolean): Promise<void> {
    if (!checklistAcknowledged || !this.checklistAcknowledged) {
      this.error = { message: "Complete the integration update checklist before approving rotation." };
      this.step = "checklist";
      this.postState();
      return;
    }
    if (typedEcaName.trim() !== this.dependencies.eca.developerName) {
      this.error = {
        message: `Type the External Client App API name (${this.dependencies.eca.developerName}) exactly.`
      };
      this.step = "approval";
      this.postState();
      return;
    }
    const stagedId = this.staged?.id;
    if (!stagedId) {
      this.error = { message: "No staged credential is available. Stage and retrieve credentials again." };
      this.step = "approval";
      this.postState();
      return;
    }
    if (!this.dependencies.isOrgStillSelected(this.dependencies.org)) {
      this.fail(
        new AppError({
          code: "ORG_MISMATCH",
          userMessage:
            "The active Salesforce org changed while this wizard was open. Close the wizard, re-select the org, and start again. No rotation was performed."
        })
      );
      return;
    }

    await this.perform(async () => {
      const confirmed = await this.confirmWarning(
        "Rotate credentials now?",
        [
          `Org: ${this.orgLabel()}`,
          `External Client App: ${this.dependencies.eca.name} (${this.dependencies.eca.developerName})`,
          `Consumer ID: ${this.scope.consumerId}`,
          "",
          "This activates the staged client ID and secret and invalidates the current ones. Integrations that still use the old credentials will fail immediately.",
          "",
          "This action cannot be undone from this extension."
        ].join("\n"),
        "Rotate Now"
      );
      if (!confirmed) {
        this.notice = "Rotation was cancelled. The staged credentials remain active but have not replaced the current credentials.";
        return;
      }

      const outcome = await this.dependencies.rotation.rotate(
        this.dependencies.org,
        this.dependencies.eca,
        stagedId,
        {
          confirmed: true,
          checklistAcknowledged: true,
          typedEcaName
        }
      );

      this.result = {
        status: outcome.status,
        rotatedAt: outcome.rotatedAt,
        httpStatus: outcome.httpStatus,
        admin: outcome.admin,
        apiVersion: outcome.apiVersion,
        auditId: outcome.auditId,
        auditPath: outcome.auditPath,
        staged: outcome.staged,
        verification: outcome.verification,
        authenticationTested: outcome.authenticationTested
      };
      this.step = "result";
      this.validation = undefined;
      this.revealed = false;
      this.error = undefined;
      this.notice =
        outcome.status === "verified"
          ? "Rotation verified. Update integrations with the new client ID and secret, then validate them separately."
          : "Rotation was accepted but could not be verified. Do not assume the new credentials are active.";
      await this.notifyChanged();
    });
  }

  private async validate(): Promise<void> {
    if (this.busy) {
      return;
    }
    const stagedId = this.staged?.id;
    if (!stagedId) {
      this.error = { message: "No staged credential is available for validation." };
      this.postState();
      return;
    }
    const confirmed = await this.confirmWarning(
      "Run optional OAuth Client Credentials validation?",
      [
        `Org: ${this.orgLabel()}`,
        `External Client App: ${this.dependencies.eca.developerName}`,
        "",
        "This sends a Client Credentials OAuth token request using the new client ID and secret.",
        "Only proceed if Client Credentials Flow is enabled for this app and a Run-As user is assigned. This is not a general connectivity test.",
        "The issued access token is discarded and never displayed or logged."
      ].join("\n"),
      "Run Validation"
    );
    if (!confirmed) {
      return;
    }

    this.busy = true;
    this.error = undefined;
    this.postState();
    try {
      this.validation = await this.dependencies.rotation.validateIntegration(
        this.dependencies.org,
        this.dependencies.eca,
        stagedId,
        { confirmed: true }
      );
      await this.notifyChanged();
    } catch (error) {
      this.busy = false;
      this.fail(error, "result");
      return;
    } finally {
      this.busy = false;
    }
    this.postState();
  }

  private async deleteStaged(): Promise<void> {
    await this.perform(async () => {
      const stagedId = await this.resolveStagedId();
      if (!stagedId) {
        throw new AppError({
          code: "VALIDATION",
          userMessage: "No staged credential is available to delete."
        });
      }
      const confirmed = await this.confirmWarning(
        "Delete the staged credential?",
        [
          `Org: ${this.orgLabel()}`,
          `External Client App: ${this.dependencies.eca.developerName}`,
          `Staged credential: ${stagedId}`,
          "",
          "Deleting a staged credential removes the staged credential record. The currently active client ID and secret are not changed."
        ].join("\n"),
        "Delete Staged Credential"
      );
      if (!confirmed) {
        return;
      }
      if (this.disposed) {
        return;
      }
      const wasRotated = this.result?.staged?.state === "rotated";
      await this.dependencies.rotation.deleteStagedCredential(
        this.dependencies.org,
        this.dependencies.eca,
        stagedId,
        { confirmed: true }
      );
      this.dependencies.credentials.clear();
      this.staged = undefined;
      this.revealed = false;
      this.checklistAcknowledged = false;
      this.result = undefined;
      this.validation = undefined;
      this.notice = wasRotated
        ? "Rotated staged credential deleted. The active client ID and secret were not changed."
        : "Staged credential deleted.";
      await this.notifyChanged();
      await this.loadPreflight();
    });
  }

  private async restart(): Promise<void> {
    await this.perform(async () => {
      this.dependencies.credentials.clear();
      this.preflight = undefined;
      this.staged = undefined;
      this.checklistAcknowledged = false;
      this.revealed = false;
      this.result = undefined;
      this.validation = undefined;
      this.error = undefined;
      this.notice = undefined;
      await this.loadPreflight();
    });
  }

  private async resolveStagedId(): Promise<string | undefined> {
    if (this.staged?.id) {
      return this.staged.id;
    }
    const candidates = (this.preflight?.existingStaged ?? []).filter(
      (entry) => entry.state === "active" || entry.state === "rotated"
    );
    if (candidates.length === 1) {
      this.staged = candidates[0];
      return candidates[0].id;
    }
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
          title: "Select a staged credential",
          placeHolder: "Only one staged credential can be handled at a time."
        }
      );
      if (!picked) {
        return undefined;
      }
      this.staged = picked.entry;
      return picked.entry.id;
    }
    return undefined;
  }

  private getHeldCredential(): StagedCredentialSecret | undefined {
    return this.dependencies.credentials.get(this.scope);
  }

  private async perform(action: () => Promise<void>): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.error = undefined;
    this.postState();
    try {
      await action();
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy = false;
      this.postState();
    }
  }

  private fail(error: unknown, keepStep?: WizardStep): void {
    const appError = toAppError(error, "The credential operation failed.");
    if (appError.code === "CANCELLED") {
      return;
    }
    this.dependencies.logger.error(`Rotation wizard failed during ${this.step}.`, error);
    const rotationFailure = error instanceof RotationFailedError ? error : undefined;
    this.error = {
      message: appError.userMessage,
      auditId: rotationFailure?.auditId,
      auditPath: rotationFailure?.auditPath
    };
    this.step = keepStep ?? (this.step === "approval" && appError.code === "VALIDATION" ? "approval" : "failed");
    this.dependencies.logger.warn(`Rotation wizard error summary: ${errorSummary(error)}`);
    this.postState();
  }

  private async notifyChanged(): Promise<void> {
    try {
      await this.dependencies.onChanged();
    } catch (error) {
      this.dependencies.logger.warn(`Post-operation refresh failed: ${errorSummary(error)}`);
    }
  }

  private async confirmWarning(title: string, detail: string, button: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(title, { modal: true, detail }, button);
    return choice === button;
  }

  private orgLabel(): string {
    const org = this.dependencies.org;
    return `${org.alias ? `${org.alias} / ` : ""}${org.username} (${org.environment})`;
  }

  private clearRevealTimer(): void {
    if (this.revealTimer) {
      clearTimeout(this.revealTimer);
      this.revealTimer = undefined;
    }
  }

  private postState(): void {
    if (this.disposed) {
      return;
    }
    this.lastViewModel = this.buildViewModel();
    void this.panel.webview.postMessage(this.lastViewModel);
  }

  private buildViewModel(): WizardViewModel {
    const held = this.getHeldCredential();
    const now = Date.now();
    const expiresAt = this.dependencies.credentials.expiresAt;
    const staged = this.staged;
    return {
      type: "state",
      step: this.step,
      busy: this.busy,
      intent: this.intent,
      org: orgView(this.dependencies.org),
      eca: {
        name: this.dependencies.eca.name,
        developerName: this.dependencies.eca.developerName,
        identifier: this.dependencies.eca.identifier,
        consumerId: this.dependencies.eca.consumer?.id,
        isFromPackage: this.dependencies.eca.isFromPackage,
        supported: this.dependencies.eca.supported,
        unsupportedReason: this.dependencies.eca.unsupportedReason
      },
      preflight: this.preflight
        ? {
            checks: this.preflight.checks,
            canStage: this.preflight.canStage,
            apiVersion: this.preflight.apiVersion,
            existingStaged: this.preflight.existingStaged
          }
        : undefined,
      staged,
      credentials:
        held && this.step !== "preflight" && this.step !== "staged"
          ? {
              clientId: held.clientId,
              stagedCredentialId: held.stagedCredentialId,
              retrievedAt: held.retrievedAt,
              expirationDate: held.expirationDate ?? staged?.expirationDate,
              revealed: this.revealed,
              secret: this.revealed ? held.clientSecret : undefined,
              expiresInSeconds:
                expiresAt !== undefined ? Math.max(0, Math.round((expiresAt - now) / 1000)) : undefined
            }
          : undefined,
      checklistAcknowledged: this.checklistAcknowledged,
      result: this.result,
      validation: this.validation,
      error: this.error,
      notice: this.notice
    };
  }
}

function createNonce(): string {
  return randomBytes(24).toString("base64url");
}
