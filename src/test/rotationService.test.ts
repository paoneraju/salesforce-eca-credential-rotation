import * as assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EcaApi } from "../core/api/ecaApi";
import { AuditService } from "../core/audit/auditService";
import { CredentialSession } from "../core/credentials/credentialSession";
import { ApiError, AppError } from "../core/errors";
import { NoopLogger } from "../core/logger";
import {
  RotationFailedError,
  RotationService,
  type SessionProvider
} from "../core/rotation/rotationService";
import {
  OrgSession,
  type Eca,
  type EcaConsumer,
  type SalesforceOrg,
  type StagedCredentialInfo,
  type StagedCredentialState
} from "../core/types";

const APP = "0xI000000000000001";
const CONSUMER = "C000000000000001";
const STAGED = "S000000000000001";
const NEW_CLIENT_ID = "NEW_CLIENT_ID_SENTINEL";
const NEW_SECRET = "NEW_CLIENT_SECRET_SENTINEL";

const tempDirectories: string[] = [];

interface HarnessOptions {
  isFromPackage?: boolean;
  supported?: boolean;
  unsupportedReason?: string;
  sessionClientId?: string;
  existing?: StagedCredentialInfo[];
  activeKeyAfterRotate?: string;
  rotateError?: Error;
}

interface Harness {
  org: SalesforceOrg;
  eca: Eca;
  credentials: CredentialSession;
  audit: AuditService;
  rotation: RotationService;
  stats: { stageCalls: number; rotateCalls: number };
  readAudit: () => Promise<string>;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eca-rotation-test-"));
  tempDirectories.push(directory);

  const org: SalesforceOrg = {
    alias: "dev",
    username: "admin@example.com",
    orgId: "00D000000000001",
    instanceUrl: "https://example.my.salesforce.com",
    environment: "Production",
    isDevHub: false,
    isSandbox: false,
    isScratch: false,
    status: "connected"
  };
  const consumer: EcaConsumer = { id: CONSUMER, key: "CURRENT_CLIENT_ID", name: "Consumer" };
  const eca: Eca = {
    identifier: APP,
    developerName: "My_App",
    name: "My App",
    isFromPackage: options.isFromPackage ?? false,
    consumer,
    orgUsername: org.username,
    orgAlias: org.alias,
    supported: options.supported ?? true,
    unsupportedReason: options.unsupportedReason
  };

  const staged: StagedCredentialInfo[] = (options.existing ?? [
    { id: STAGED, state: "active", createdDate: "2026-01-01T00:00:00.000Z" }
  ]).map((entry) => ({ ...entry }));
  const stats = { stageCalls: 0, rotateCalls: 0 };

  const api = {
    getApiVersion: async (): Promise<string> => "v66.0",
    validateConsumer: async (): Promise<EcaConsumer> => ({ ...consumer }),
    listStagedCredentials: async (): Promise<StagedCredentialInfo[]> =>
      staged.map((entry) => ({ ...entry })),
    stageCredentials: async (): Promise<{ staged: StagedCredentialInfo; httpStatus: number }> => {
      stats.stageCalls += 1;
      const created: StagedCredentialInfo = { id: STAGED, state: "active" };
      staged.push(created);
      return { staged: created, httpStatus: 201 };
    },
    retrieveStagedCredential: async (): Promise<{
      stagedCredentialId: string;
      clientId: string;
      clientSecret: string;
      state: StagedCredentialState;
      retrievedAt: string;
    }> => ({
      stagedCredentialId: STAGED,
      clientId: NEW_CLIENT_ID,
      clientSecret: NEW_SECRET,
      state: "active",
      retrievedAt: new Date().toISOString()
    }),
    rotateCredential: async (): Promise<{ staged: StagedCredentialInfo; httpStatus: number }> => {
      if (options.rotateError) {
        throw options.rotateError;
      }
      stats.rotateCalls += 1;
      const target = staged.find((entry) => entry.id === STAGED);
      if (target) {
        target.state = "rotated";
      }
      return { staged: { id: STAGED, state: "rotated" }, httpStatus: 200 };
    },
    getActiveConsumerKey: async (): Promise<string> =>
      options.activeKeyAfterRotate ?? NEW_CLIENT_ID,
    deleteStagedCredential: async (): Promise<number> => 204
  };

  const session = new OrgSession({
    org,
    accessToken: "ACCESS_TOKEN_SENTINEL",
    apiVersion: "66.0",
    clientId: options.sessionClientId
  });
  const sessions: SessionProvider = { assertSession: async () => session };
  let auditSequence = 0;
  const audit = new AuditService({
    directory,
    extensionVersion: "test",
    idFactory: () => `audit-${++auditSequence}`
  });
  const credentials = new CredentialSession({ ttlMs: 10 * 60_000 });

  const rotation = new RotationService({
    sessions,
    apiFactory: () => api as unknown as EcaApi,
    audit,
    credentials,
    logger: new NoopLogger()
  });

  return {
    org,
    eca,
    credentials,
    audit,
    rotation,
    stats,
    readAudit: () => fs.readFile(audit.filePath, "utf8")
  };
}

function scope(org: SalesforceOrg): {
  orgId?: string;
  orgUsername: string;
  appIdentifier: string;
  consumerId: string;
} {
  return {
    orgId: org.orgId,
    orgUsername: org.username,
    appIdentifier: APP,
    consumerId: CONSUMER
  };
}

describe("RotationService", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
    );
  });

  it("blocks preflight for packaged External Client Apps", async () => {
    const harness = await createHarness({
      isFromPackage: true,
      supported: false,
      unsupportedReason: "Packaged apps cannot be rotated."
    });
    const result = await harness.rotation.preflight(harness.org, harness.eca);
    assert.equal(result.canStage, false);
    assert.equal(result.checks.find((check) => check.id === "packaged")?.severity, "fail");
    assert.equal(result.checks.find((check) => check.id === "supported")?.severity, "fail");
    assert.equal(result.apiVersion, "v66.0");
  });

  it("blocks preflight when the CLI session uses the target client ID", async () => {
    const harness = await createHarness({
      sessionClientId: "CURRENT_CLIENT_ID",
      existing: []
    });
    const result = await harness.rotation.preflight(harness.org, harness.eca);
    assert.equal(result.canStage, false);
    assert.equal(result.checks.find((check) => check.id === "self-session")?.severity, "fail");
  });

  it("refuses to replace an active staged credential without acknowledgment", async () => {
    const harness = await createHarness();
    await assert.rejects(
      harness.rotation.stage(harness.org, harness.eca, {}),
      (error: unknown) => error instanceof AppError && error.code === "VALIDATION"
    );
    assert.equal(harness.stats.stageCalls, 0);

    const result = await harness.rotation.stage(harness.org, harness.eca, {
      acknowledgeExistingStaged: true
    });
    assert.equal(result.staged.id, STAGED);
    assert.equal(harness.stats.stageCalls, 1);

    const audit = await harness.readAudit();
    assert.match(audit, /"action":"stage"/);
    assert.equal(audit.includes(NEW_SECRET), false);
  });

  it("requires explicit retrieval and keeps the secret out of the audit log", async () => {
    const harness = await createHarness();
    await assert.rejects(
      harness.rotation.retrieve(harness.org, harness.eca, STAGED, { explicit: false }),
      (error: unknown) => error instanceof AppError && error.code === "VALIDATION"
    );
    assert.equal(harness.credentials.has(), false);

    const result = await harness.rotation.retrieve(harness.org, harness.eca, STAGED, {
      explicit: true
    });
    assert.equal(result.clientSecret, NEW_SECRET);
    assert.equal(harness.credentials.get(scope(harness.org))?.clientSecret, NEW_SECRET);

    const audit = await harness.readAudit();
    assert.match(audit, /"action":"retrieve"/);
    assert.equal(audit.includes(NEW_SECRET), false);
    assert.equal(audit.includes(NEW_CLIENT_ID), false);
    assert.equal(audit.includes("ACCESS_TOKEN_SENTINEL"), false);
  });

  it("requires retrieved credentials before rotating", async () => {
    const harness = await createHarness();
    await assert.rejects(
      harness.rotation.rotate(harness.org, harness.eca, STAGED, {
        confirmed: true,
        checklistAcknowledged: true,
        typedEcaName: "My_App"
      }),
      (error: unknown) => error instanceof AppError && error.code === "VALIDATION"
    );
    assert.equal(harness.stats.rotateCalls, 0);
  });

  it("verifies rotation by state and active key, not by HTTP status", async () => {
    const harness = await createHarness();
    await harness.rotation.retrieve(harness.org, harness.eca, STAGED, { explicit: true });

    const outcome = await harness.rotation.rotate(harness.org, harness.eca, STAGED, {
      confirmed: true,
      checklistAcknowledged: true,
      typedEcaName: "My_App"
    });

    assert.equal(outcome.status, "verified");
    assert.equal(outcome.httpStatus, 200);
    assert.equal(outcome.authenticationTested, false);
    assert.equal(outcome.verification.activeConsumerKeyMatches, true);
    assert.equal(outcome.verification.stagedState, "rotated");
    assert.equal(harness.stats.rotateCalls, 1);
    assert.ok(outcome.auditId);

    const audit = await harness.readAudit();
    assert.match(audit, /"action":"rotate"/);
    assert.match(audit, /"outcome":"verified"/);
    assert.match(audit, /not authentication-tested/);
    assert.equal(audit.includes(NEW_SECRET), false);
    assert.equal(audit.includes(NEW_CLIENT_ID), false);
  });

  it("reports unverified when the active key does not match the new client ID", async () => {
    const harness = await createHarness({ activeKeyAfterRotate: "SOME_OTHER_KEY" });
    await harness.rotation.retrieve(harness.org, harness.eca, STAGED, { explicit: true });

    const outcome = await harness.rotation.rotate(harness.org, harness.eca, STAGED, {
      confirmed: true,
      checklistAcknowledged: true,
      typedEcaName: "My_App"
    });

    assert.equal(outcome.status, "unverified");
    assert.equal(outcome.verification.activeConsumerKeyMatches, false);
    const audit = await harness.readAudit();
    assert.match(audit, /"outcome":"unverified"/);
  });

  it("refuses to rotate an already rotated staged credential", async () => {
    const harness = await createHarness({
      existing: [{ id: STAGED, state: "rotated" }]
    });
    await harness.rotation.retrieve(harness.org, harness.eca, STAGED, { explicit: true });

    await assert.rejects(
      harness.rotation.rotate(harness.org, harness.eca, STAGED, {
        confirmed: true,
        checklistAcknowledged: true,
        typedEcaName: "My_App"
      }),
      (error: unknown) => error instanceof AppError && error.code === "VALIDATION"
    );

    const audit = await harness.readAudit();
    assert.match(audit, /"action":"rotate"/);
    assert.match(audit, /"outcome":"failed"/);
  });

  it("surfaces a rotation failure with an audit ID and no secrets", async () => {
    const harness = await createHarness({
      rotateError: new ApiError({ status: 500, message: "Salesforce failed" })
    });
    await harness.rotation.retrieve(harness.org, harness.eca, STAGED, { explicit: true });

    await assert.rejects(
      harness.rotation.rotate(harness.org, harness.eca, STAGED, {
        confirmed: true,
        checklistAcknowledged: true,
        typedEcaName: "My_App"
      }),
      (error: unknown) => {
        assert.ok(error instanceof RotationFailedError);
        assert.ok(error.auditId.startsWith("audit-"));
        assert.equal(error.httpStatus, 500);
        return true;
      }
    );

    const audit = await harness.readAudit();
    assert.equal(audit.includes(NEW_SECRET), false);
    assert.equal(audit.includes(NEW_CLIENT_ID), false);
  });

  it("deletes a staged credential only after confirmation and clears held credentials", async () => {
    const harness = await createHarness();
    await harness.rotation.retrieve(harness.org, harness.eca, STAGED, { explicit: true });
    await assert.rejects(
      harness.rotation.deleteStagedCredential(harness.org, harness.eca, STAGED, { confirmed: false }),
      (error: unknown) => error instanceof AppError && error.code === "CANCELLED"
    );
    assert.equal(harness.credentials.has(), true);

    await harness.rotation.deleteStagedCredential(harness.org, harness.eca, STAGED, {
      confirmed: true
    });
    assert.equal(harness.credentials.has(), false);

    const audit = await harness.readAudit();
    assert.match(audit, /"action":"delete-staged"/);
    assert.equal(audit.includes(NEW_SECRET), false);
  });
});
