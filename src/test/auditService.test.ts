import * as assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuditService, type AuditRecordInput } from "../core/audit/auditService";

function input(overrides: Partial<AuditRecordInput> = {}): AuditRecordInput {
  return {
    action: "rotate",
    outcome: "verified",
    org: {
      alias: "dev",
      username: "admin@example.com",
      orgId: "00D000000000001",
      instanceUrl: "https://example.my.salesforce.com",
      environment: "Production"
    },
    eca: {
      developerName: "My_App",
      name: "My App",
      identifier: "0xI000000000000001",
      consumerId: "C000000000000001",
      isFromPackage: false
    },
    admin: "admin@example.com",
    ...overrides
  };
}

describe("AuditService", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "eca-audit-test-"));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("writes secret-free JSONL records and reads them newest first", async () => {
    let sequence = 0;
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const audit = new AuditService({
      directory,
      extensionVersion: "1.2.3",
      idFactory: () => `audit-${++sequence}`,
      now: () => {
        const value = new Date(clock);
        clock += 1000;
        return value;
      }
    });

    const first = await audit.record(
      input({
        note: "client_secret=SUPER_SECRET_SENTINEL access_token=00Dxxx!AQyyy",
        error: { code: "API_ERROR", message: "refresh_token=REFRESH_SENTINEL failed" }
      })
    );
    const second = await audit.record(input({ action: "stage", outcome: "success" }));

    assert.equal(first.writeError, undefined);
    assert.equal(first.record.auditId, "audit-1");
    assert.equal(second.record.auditId, "audit-2");
    assert.equal(first.record.extensionVersion, "1.2.3");

    const content = await fs.readFile(audit.filePath, "utf8");
    assert.equal(content.trim().split("\n").length, 2);
    assert.equal(content.includes("SUPER_SECRET_SENTINEL"), false);
    assert.equal(content.includes("REFRESH_SENTINEL"), false);
    assert.equal(content.includes("00Dxxx"), false);
    assert.match(content, /\[REDACTED\]/);

    const entries = await audit.readRecent();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].record.auditId, "audit-2");
    assert.equal(entries[1].record.auditId, "audit-1");
    assert.equal(entries[0].line, 2);
  });

  it("returns an empty history when no audit file exists", async () => {
    const audit = new AuditService({ directory, extensionVersion: "1.0.0" });
    assert.deepEqual(await audit.readRecent(), []);
  });

  it("ignores malformed lines without losing valid records", async () => {
    const audit = new AuditService({ directory, extensionVersion: "1.0.0" });
    await audit.record(input());
    await fs.appendFile(audit.filePath, "{not-json}\n", "utf8");
    const entries = await audit.readRecent();
    assert.equal(entries.length, 1);
  });

  it("reports a write error instead of throwing", async () => {
    const blocker = path.join(directory, "blocker");
    await fs.writeFile(blocker, "not a directory", "utf8");
    const audit = new AuditService({ directory: path.join(blocker, "audit"), extensionVersion: "1.0.0" });
    const result = await audit.record(input());
    assert.ok(result.writeError);
    assert.equal(result.record.action, "rotate");
  });
});
