import * as vscode from "vscode";

/**
 * Clipboard writes always carry a warning. The first write per extension session uses a
 * modal confirmation; later writes repeat the warning in the notification text.
 */
export class ClipboardService {
  private acknowledged = false;

  async copy(label: string, value: string): Promise<boolean> {
    if (!this.acknowledged) {
      const choice = await vscode.window.showWarningMessage(
        "Clipboard contents may be accessible to other applications on this machine. Copy this credential anyway?",
        { modal: true },
        "Copy"
      );
      if (choice !== "Copy") {
        return false;
      }
      this.acknowledged = true;
    }
    await vscode.env.clipboard.writeText(value);
    void vscode.window.showInformationMessage(
      `${label} copied. Clipboard contents may be accessible to other applications.`
    );
    return true;
  }

  async copyWithoutCredentialWarning(label: string, value: string): Promise<void> {
    await vscode.env.clipboard.writeText(value);
    void vscode.window.showInformationMessage(`${label} copied.`);
  }

  async clear(): Promise<void> {
    await vscode.env.clipboard.writeText("");
    void vscode.window.showInformationMessage("Clipboard cleared.");
  }
}
