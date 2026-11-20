import type { ExecFileOptions } from "node:child_process";
import { execFile } from "node:child_process";
import { AppError } from "../errors";
import { Logger, NoopLogger, errorSummary } from "../logger";
import { redact } from "../redact";

export interface CliExecError extends Error {
  code?: string | number;
  killed?: boolean;
  signal?: string;
  stdout?: string;
  stderr?: string;
}

export interface CliExecOptions {
  maxBuffer: number;
  timeout: number;
  windowsHide: boolean;
  encoding: "utf8";
  env: NodeJS.ProcessEnv;
}

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: CliExecOptions,
  callback: (error: CliExecError | null, stdout: string, stderr: string) => void
) => void;

export interface SfCliOptions {
  sfPath: string;
  timeoutMs: number;
  runner?: ExecFileFn;
  logger?: Logger;
}

export interface CliRunResult {
  stdout: string;
  stderr: string;
}

export interface CliJsonResult<T> extends CliRunResult {
  value: T;
}

// eslint-disable-next-line no-control-regex -- ANSI escape sequences are stripped from CLI output.
const ANSI_PATTERN = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "").replace(/^\uFEFF/, "");
}

/**
 * The CLI occasionally prints warnings before its JSON payload. Extract the first
 * parseable JSON object/array rather than trusting that stdout is pure JSON.
 */
export function parseCliJson<T>(raw: string): T {
  const cleaned = stripAnsi(raw).trim();
  if (!cleaned) {
    throw new AppError({
      code: "CLI_INVALID_OUTPUT",
      userMessage: "The Salesforce CLI returned no output."
    });
  }

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Fall through to scanning.
  }

  for (let index = cleaned.indexOf("{"); index >= 0; index = cleaned.indexOf("{", index + 1)) {
    const candidate = cleaned.slice(index);
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try the next opening brace.
    }
  }

  throw new AppError({
    code: "CLI_INVALID_OUTPUT",
    userMessage: "The Salesforce CLI returned output that was not valid JSON.",
    details: redact(cleaned.slice(0, 300))
  });
}

export function assertSafeOrgRef(orgRef: string): string {
  const value = orgRef.trim();
  if (!value || value.length > 255) {
    throw new AppError({
      code: "VALIDATION",
      userMessage: "The selected Salesforce org reference is empty or too long."
    });
  }
  if (value.startsWith("-")) {
    throw new AppError({
      code: "VALIDATION",
      userMessage: "The selected Salesforce org reference is not valid."
    });
  }
  // eslint-disable-next-line no-control-regex -- control characters must be rejected in org references.
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new AppError({
      code: "VALIDATION",
      userMessage: "The selected Salesforce org reference contains invalid control characters."
    });
  }
  return value;
}

export class SfCli {
  private options: SfCliOptions;
  private readonly runner: ExecFileFn;

  constructor(options: SfCliOptions) {
    this.options = options;
    this.runner =
      options.runner ??
      ((file, args, execOptions, callback) => {
        execFile(
          file,
          [...args],
          execOptions as ExecFileOptions,
          (error, stdout, stderr) => {
            callback(error as CliExecError | null, String(stdout), String(stderr));
          }
        );
      });
  }

  updateOptions(options: Omit<SfCliOptions, "runner">): void {
    this.options = { ...this.options, ...options };
  }

  get logger(): Logger {
    return this.options.logger ?? new NoopLogger();
  }

  async run(args: string[]): Promise<CliRunResult> {
    const sfPath = this.options.sfPath.trim() || "sf";
    const commandForLog = sanitizeArgsForLog(args);
    this.logger.debug(`Running Salesforce CLI: ${sfPath} ${commandForLog}`);

    return new Promise<CliRunResult>((resolve, reject) => {
      const runnerOptions: CliExecOptions = {
        maxBuffer: 10 * 1024 * 1024,
        timeout: this.options.timeoutMs,
        windowsHide: true,
        encoding: "utf8",
        env: {
          ...process.env,
          SF_DISABLE_TELEMETRY: "true",
          NO_COLOR: "1"
        }
      };

      try {
        this.runner(sfPath, args, runnerOptions, (error, stdout, stderr) => {
          if (!error) {
            resolve({ stdout, stderr });
            return;
          }

          if (error.code === "ENOENT") {
            reject(
              new AppError({
                code: "CLI_NOT_FOUND",
                userMessage: `Salesforce CLI executable not found: ${sfPath}. Install the Salesforce CLI or set salesforceEca.sfCliPath.`,
                cause: error
              })
            );
            return;
          }

          if (error.killed || error.code === "ETIMEDOUT" || error.signal === "SIGTERM") {
            reject(
              new AppError({
                code: "CLI_TIMEOUT",
                userMessage: `The Salesforce CLI did not finish within ${this.options.timeoutMs} ms.`,
                cause: error
              })
            );
            return;
          }

          const combined = `${stdout ?? ""}\n${stderr ?? ""}`;
          const cliMessage = extractCliErrorMessage(combined);
          reject(
            new AppError({
              code: "CLI_FAILED",
              userMessage: cliMessage
                ? `Salesforce CLI command failed: ${cliMessage}`
                : "The Salesforce CLI command failed.",
              cause: error,
              details: errorSummary(error)
            })
          );
        });
      } catch (error) {
        reject(
          new AppError({
            code: "CLI_FAILED",
            userMessage: "The Salesforce CLI could not be started.",
            cause: error,
            details: errorSummary(error)
          })
        );
      }
    });
  }

  async runJson<T>(args: string[]): Promise<CliJsonResult<T>> {
    const result = await this.run(args);
    const value = parseCliJson<T>(result.stdout);
    return { ...result, value };
  }
}

function sanitizeArgsForLog(args: readonly string[]): string {
  return args.map((arg) => (/^--/.test(arg) ? arg : "<value>")).join(" ");
}

function extractCliErrorMessage(output: string): string | undefined {
  if (!output.trim()) {
    return undefined;
  }
  try {
    const parsed = parseCliJson<Record<string, unknown>>(output);
    if (typeof parsed.message === "string") {
      return redact(parsed.message);
    }
    if (typeof parsed.name === "string") {
      return redact(parsed.name);
    }
  } catch {
    // Not JSON.
  }
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("›") && !line.includes("update available"));
  return lines[0] ? redact(lines[0].slice(0, 400)) : undefined;
}
