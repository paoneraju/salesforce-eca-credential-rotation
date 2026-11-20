import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Logger, NoopLogger } from "../logger";
import { redact } from "../redact";
import type { AuditRecord, EcaAuditSnapshot, OrgAuditSnapshot } from "../types";

export type AuditRecordInput = Omit<AuditRecord, "auditId" | "timestamp" | "extensionVersion">;

export interface AuditWriteResult {
  record: AuditRecord;
  filePath: string;
  writeError?: string;
}

export interface AuditEntry {
  record: AuditRecord;
  line: number;
  filePath: string;
}

export interface AuditServiceOptions {
  directory: string;
  extensionVersion: string;
  logger?: Logger;
  now?: () => Date;
  idFactory?: () => string;
}

const AUDIT_FILE = "rotation-audit.jsonl";

function sanitizeSnapshot(org: OrgAuditSnapshot): OrgAuditSnapshot {
  return {
    alias: org.alias ? redact(org.alias) : undefined,
    username: redact(org.username),
    orgId: org.orgId,
    instanceUrl: org.instanceUrl,
    environment: org.environment
  };
}

function sanitizeEca(eca: EcaAuditSnapshot): EcaAuditSnapshot {
  return {
    developerName: redact(eca.developerName),
    name: redact(eca.name),
    identifier: eca.identifier,
    consumerId: eca.consumerId,
    isFromPackage: eca.isFromPackage
  };
}

function buildRecord(
  input: AuditRecordInput,
  extensionVersion: string,
  auditId: string,
  timestamp: string
): AuditRecord {
  const record: AuditRecord = {
    auditId,
    timestamp,
    action: input.action,
    outcome: input.outcome,
    org: sanitizeSnapshot(input.org),
    eca: sanitizeEca(input.eca),
    admin: redact(input.admin),
    extensionVersion
  };

  if (input.apiVersion) {
    record.apiVersion = input.apiVersion;
  }
  if (input.stagedCredential) {
    record.stagedCredential = {
      id: input.stagedCredential.id,
      state: input.stagedCredential.state,
      createdDate: input.stagedCredential.createdDate,
      expirationDate: input.stagedCredential.expirationDate
    };
  }
  if (input.httpStatus !== undefined) {
    record.httpStatus = input.httpStatus;
  }
  if (input.verification) {
    record.verification = {
      stagedState: input.verification.stagedState,
      activeConsumerKeyMatches: input.verification.activeConsumerKeyMatches,
      checkedAt: input.verification.checkedAt
    };
  }
  if (input.integrationValidation) {
    record.integrationValidation = {
      attempted: input.integrationValidation.attempted,
      ok: input.integrationValidation.ok,
      errorCode: input.integrationValidation.errorCode
        ? redact(input.integrationValidation.errorCode)
        : undefined
    };
  }
  if (input.error) {
    record.error = {
      code: input.error.code,
      message: redact(input.error.message)
    };
  }
  if (input.note) {
    record.note = redact(input.note);
  }
  return record;
}

export class AuditService {
  private readonly directory: string;
  private readonly extensionVersion: string;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: AuditServiceOptions) {
    this.directory = options.directory;
    this.extensionVersion = options.extensionVersion;
    this.logger = options.logger ?? new NoopLogger();
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
  }

  get filePath(): string {
    return path.join(this.directory, AUDIT_FILE);
  }

  async record(input: AuditRecordInput): Promise<AuditWriteResult> {
    const record = buildRecord(input, this.extensionVersion, this.idFactory(), this.now().toISOString());
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      await fs.appendFile(this.filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      try {
        await fs.chmod(this.filePath, 0o600);
      } catch {
        // Best effort on platforms that do not support POSIX permissions.
      }
      this.logger.info(`Wrote audit record ${record.auditId} (${record.action}/${record.outcome}).`);
      return { record, filePath: this.filePath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("Could not write the rotation audit record.", error);
      return {
        record,
        filePath: this.filePath,
        writeError: redact(message)
      };
    }
  }

  async readRecent(limit = 50): Promise<AuditEntry[]> {
    let content: string;
    try {
      content = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      const code = error as NodeJS.ErrnoException;
      if (code.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const entries: AuditEntry[] = [];
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as AuditRecord;
        if (parsed && typeof parsed === "object" && typeof parsed.auditId === "string") {
          entries.push({ record: parsed, line: index + 1, filePath: this.filePath });
        }
      } catch {
        // Ignore malformed lines rather than breaking the whole history view.
      }
    }

    return entries
      .sort((left, right) => {
        const leftTime = Date.parse(left.record.timestamp) || 0;
        const rightTime = Date.parse(right.record.timestamp) || 0;
        return rightTime - leftTime;
      })
      .slice(0, limit);
  }
}
