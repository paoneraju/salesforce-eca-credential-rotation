import { redact } from "./redact";

export type ErrorCode =
  | "CLI_NOT_FOUND"
  | "CLI_FAILED"
  | "CLI_TIMEOUT"
  | "CLI_INVALID_OUTPUT"
  | "ORG_NOT_FOUND"
  | "ORG_MISMATCH"
  | "ORG_SESSION_EXPIRED"
  | "ORG_INVALID_URL"
  | "API_VERSION_UNSUPPORTED"
  | "API_AUTH"
  | "API_PERMISSION"
  | "API_NOT_FOUND"
  | "API_CONFLICT"
  | "API_ERROR"
  | "VALIDATION"
  | "UNSUPPORTED"
  | "ROTATION_FAILED"
  | "VERIFICATION_FAILED"
  | "AUDIT_FAILED"
  | "CANCELLED"
  | "INTERNAL";

export interface AppErrorOptions {
  code: ErrorCode;
  userMessage: string;
  cause?: unknown;
  details?: string;
  remediation?: string;
}

/** Base error whose message is safe to display and whose cause is never serialized raw. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly userMessage: string;
  readonly remediation?: string;
  readonly details?: string;

  constructor(options: AppErrorOptions) {
    super(redact(options.userMessage));
    this.name = "AppError";
    this.code = options.code;
    this.userMessage = redact(options.userMessage);
    this.remediation = options.remediation ? redact(options.remediation) : undefined;
    this.details = options.details ? redact(options.details) : undefined;
    if (options.cause !== undefined) {
      // Keep a reference for programmatic inspection, but never expose it via JSON.
      Object.defineProperty(this, "cause", {
        value: options.cause,
        enumerable: false,
        configurable: true,
        writable: true
      });
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.userMessage,
      remediation: this.remediation,
      details: this.details
    };
  }
}

export class AuthError extends AppError {
  constructor(message: string, options?: { cause?: unknown; details?: string; remediation?: string }) {
    super({
      code: "ORG_SESSION_EXPIRED",
      userMessage: message,
      cause: options?.cause,
      details: options?.details,
      remediation:
        options?.remediation ??
        "Re-authenticate with `sf org login web --alias <alias>` and refresh the org list."
    });
    this.name = "AuthError";
  }
}

export class ApiError extends AppError {
  readonly status: number;
  readonly salesforceCode?: string;
  readonly requestId?: string;
  readonly bodyMessage?: string;

  constructor(options: {
    status: number;
    message: string;
    salesforceCode?: string;
    requestId?: string;
    details?: string;
  }) {
    const isAuth = options.status === 401;
    const isPermission = options.status === 403;
    const isNotFound = options.status === 404;
    const isConflict = options.status === 409;
    super({
      code: isAuth
        ? "API_AUTH"
        : isPermission
          ? "API_PERMISSION"
          : isNotFound
            ? "API_NOT_FOUND"
            : isConflict
              ? "API_CONFLICT"
              : "API_ERROR",
      userMessage: options.message,
      details: options.details,
      remediation: isAuth
        ? "The Salesforce access token is no longer valid. Re-authenticate with `sf org login web --alias <alias>`, then refresh."
        : isPermission
          ? "Verify External Client App permissions and enable Setup > External Client Apps > Settings > Allow access to External Client App consumer secrets via REST API."
          : isNotFound
            ? "Confirm that the External Client App exists, that credentials are still staged, and that the org supports API v65.0 or later."
            : undefined
    });
    this.name = "ApiError";
    this.status = options.status;
    this.salesforceCode = options.salesforceCode;
    this.requestId = options.requestId;
    this.bodyMessage = options.message;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function toAppError(error: unknown, fallbackMessage: string): AppError {
  if (error instanceof AppError) {
    return error;
  }
  if (error instanceof Error) {
    return new AppError({
      code: "INTERNAL",
      userMessage: fallbackMessage,
      cause: error,
      details: error.message
    });
  }
  return new AppError({
    code: "INTERNAL",
    userMessage: fallbackMessage,
    details: String(error)
  });
}

export function isAuthError(error: unknown): boolean {
  return error instanceof AuthError || (error instanceof ApiError && error.status === 401);
}
