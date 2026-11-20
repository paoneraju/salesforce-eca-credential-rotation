import { AppError } from "./errors";
import { redact } from "./redact";

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
  show(): void;
}

export class NoopLogger implements Logger {
  debug(_message: string): void {}
  info(_message: string): void {}
  warn(_message: string): void {}
  error(_message: string, _error?: unknown): void {}
  show(): void {}
}

export function errorSummary(error: unknown): string {
  if (error instanceof AppError) {
    const parts = [`[${error.code}] ${error.userMessage}`];
    if (error.details) {
      parts.push(`details=${error.details}`);
    }
    if (error.remediation) {
      parts.push(`remediation=${error.remediation}`);
    }
    return redact(parts.join(" | "));
  }
  if (error instanceof Error) {
    return redact(`${error.name}: ${error.message}`);
  }
  return redact(String(error));
}
