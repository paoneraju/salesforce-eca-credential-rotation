import type * as vscode from "vscode";
import { ExtensionController } from "./ui/extensionController";

let controller: ExtensionController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  controller = new ExtensionController(context);
  controller.activate();
  context.subscriptions.push({
    dispose: () => {
      controller?.dispose();
      controller = undefined;
    }
  });
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}
