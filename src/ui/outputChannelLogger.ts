import * as vscode from "vscode";
import { errorSummary, type Logger } from "../core/logger";
import { redact } from "../core/redact";

export class OutputChannelLogger implements Logger {
  constructor(private readonly channel: vscode.OutputChannel) {}

  debug(message: string): void {
    this.append("debug", message);
  }

  info(message: string): void {
    this.append("info", message);
  }

  warn(message: string): void {
    this.append("warn", message);
  }

  error(message: string, error?: unknown): void {
    const suffix = error === undefined ? "" : ` | ${errorSummary(error)}`;
    this.append("error", `${message}${suffix}`);
  }

  show(): void {
    this.channel.show(true);
  }

  private append(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    this.channel.appendLine(`[${timestamp}] [${level.toUpperCase()}] ${redact(message)}`);
  }
}
