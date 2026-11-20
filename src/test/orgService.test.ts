import * as assert from "node:assert/strict";
import { AuthError, AppError } from "../core/errors";
import {
  OrgService,
  classifyConnectedStatus,
  isRedactedAccessToken,
  orgReference,
  parseAccessTokenPayload,
  parseOrgDisplay,
  parseOrgList
} from "../core/orgs/orgService";
import { SfCli } from "../core/cli/sfCli";
import type { CliExecError, ExecFileFn } from "../core/cli/sfCli";
import type { SalesforceOrg } from "../core/types";
import { FakeTransport, jsonResponse, requestPathname } from "./helpers";

const ORG: SalesforceOrg = {
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

function displayPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 0,
    result: {
      id: ORG.orgId,
      apiVersion: "66.0",
      accessToken: "00D000000000001!AQ_SENTINEL_TOKEN",
      instanceUrl: ORG.instanceUrl,
      username: ORG.username,
      alias: ORG.alias,
      clientId: "PlatformCLI",
      sfdxAuthUrl: "force://PlatformCLI::refresh-token-sentinel@example.my.salesforce.com",
      ...overrides
    }
  });
}

function cliReturning(payload: string): SfCli {
  const runner: ExecFileFn = (_file, _args, _options, callback) => {
    callback(null, payload, "");
  };
  return new SfCli({ sfPath: "sf", timeoutMs: 5000, runner });
}

function cliRouting(handler: (args: readonly string[]) => string): SfCli {
  const runner: ExecFileFn = (_file, args, _options, callback) => {
    try {
      callback(null, handler(args), "");
    } catch (error) {
      callback(error as CliExecError, "", "");
    }
  };
  return new SfCli({ sfPath: "sf", timeoutMs: 5000, runner });
}

const REDACTED = "[REDACTED] See 'sf org auth show-access-token' to view";

describe("orgService parsing", () => {
  it("parses org groups while ignoring accessToken and other auth fields", () => {
    const raw = {
      status: 0,
      result: {
        devHubs: [
          {
            username: "hub@example.com",
            instanceUrl: "https://hub.my.salesforce.com",
            orgId: "00D000000000010",
            isDevHub: true,
            accessToken: "00D000000000010!AQ_SENTINEL",
            refreshToken: "refresh-sentinel"
          }
        ],
        sandboxes: [
          {
            username: "sandbox@example.com",
            instanceUrl: "https://sandbox.my.salesforce.com",
            orgId: "00D000000000011",
            isSandbox: true,
            connectedStatus: "Unable to refresh session due to expired access/refresh token"
          }
        ],
        nonScratchOrgs: [
          {
            username: "prod@example.com",
            instanceUrl: "https://prod.my.salesforce.com",
            orgId: "00D000000000012",
            isDefaultUsername: true,
            connectedStatus: "Connected"
          }
        ]
      }
    };

    const parsed = parseOrgList(raw);
    assert.equal(parsed.orgs.length, 3);

    const hub = parsed.orgs.find((org) => org.username === "hub@example.com");
    assert.equal(hub?.environment, "Dev Hub");
    assert.equal(hub?.isDevHub, true);
    assert.equal(JSON.stringify(hub).includes("SENTINEL"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(hub, "accessToken"), false);

    const sandbox = parsed.orgs.find((org) => org.username === "sandbox@example.com");
    assert.equal(sandbox?.environment, "Sandbox");
    assert.equal(sandbox?.status, "expired");

    const prod = parsed.orgs.find((org) => org.username === "prod@example.com");
    assert.equal(prod?.isDefault, true);
    assert.equal(prod?.status, "connected");
  });

  it("deduplicates the same org across groups", () => {
    const raw = {
      result: {
        nonScratchOrgs: [
          { username: "a@example.com", instanceUrl: "https://a.my.salesforce.com", orgId: "00D1" }
        ],
        other: [
          { username: "a@example.com", instanceUrl: "https://a.my.salesforce.com", orgId: "00D1" }
        ]
      }
    };
    assert.equal(parseOrgList(raw).orgs.length, 1);
  });

  it("rejects non-Salesforce instance hosts", () => {
    const parsed = parseOrgList({
      result: {
        nonScratchOrgs: [
          { username: "evil@example.com", instanceUrl: "https://evil.example.net", orgId: "00D1" }
        ]
      }
    });
    assert.equal(parsed.orgs.length, 0);
    assert.equal(parsed.warnings.length, 1);
  });

  it("classifies connected status values", () => {
    assert.equal(classifyConnectedStatus(undefined), "connected");
    assert.equal(classifyConnectedStatus("Connected"), "connected");
    assert.equal(classifyConnectedStatus("expired access/refresh token"), "expired");
    assert.equal(classifyConnectedStatus("Request failed"), "unreachable");
  });

  it("parses org display without retaining sfdxAuthUrl", () => {
    const display = parseOrgDisplay(JSON.parse(displayPayload()));
    assert.equal(display.apiVersion, "66.0");
    assert.equal(display.accessToken, "00D000000000001!AQ_SENTINEL_TOKEN");
    assert.equal(JSON.stringify(display).includes("force://"), false);
    assert.equal(JSON.stringify(display).includes("refresh-token-sentinel"), false);
  });

  it("drops a redacted org display token instead of treating it as usable", () => {
    const display = parseOrgDisplay(JSON.parse(displayPayload({ accessToken: REDACTED })));
    assert.equal(display.accessToken, undefined);
    assert.equal(isRedactedAccessToken(REDACTED), true);
    assert.equal(isRedactedAccessToken("REDACTED"), true);
    assert.equal(isRedactedAccessToken("00D000000000001!AQ_REAL"), false);
  });

  it("parses the show-access-token envelopes", () => {
    assert.equal(
      parseAccessTokenPayload({ status: 0, result: { accessToken: "00D!AQ_TOKEN" } }),
      "00D!AQ_TOKEN"
    );
    assert.equal(parseAccessTokenPayload({ result: "00D!AQ_TOKEN" }), "00D!AQ_TOKEN");
    assert.equal(parseAccessTokenPayload({ accessToken: "00D!AQ_TOKEN" }), "00D!AQ_TOKEN");
    assert.equal(parseAccessTokenPayload({ result: {} }), undefined);
  });

  it("uses the alias as the CLI reference when present", () => {
    assert.equal(orgReference(ORG), "dev");
    assert.equal(orgReference({ ...ORG, alias: "   " }), ORG.username);
  });
});

describe("OrgService.getSession", () => {
  it("returns a session only when identity and instance URL match", async () => {
    const service = new OrgService({
      cli: cliReturning(displayPayload()),
      transport: new FakeTransport(() => jsonResponse(200, {}))
    });
    const session = await service.getSession(ORG);
    assert.equal(session.org.username, ORG.username);
    assert.equal(session.apiVersion, "66.0");
    assert.equal(session.clientId, "PlatformCLI");
    assert.equal(session.accessToken, "00D000000000001!AQ_SENTINEL_TOKEN");
    assert.equal(JSON.stringify(session).includes("SENTINEL_TOKEN"), false);
  });

  it("uses sf org auth show-access-token when org display redacts the token", async () => {
    const calls: string[][] = [];
    const service = new OrgService({
      cli: cliRouting((args) => {
        calls.push([...args]);
        if (args[0] === "org" && args[1] === "display") {
          return displayPayload({ accessToken: REDACTED });
        }
        if (args[0] === "org" && args[1] === "auth") {
          return JSON.stringify({ status: 0, result: { accessToken: "00D!AQ_FRESH_TOKEN" } });
        }
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      }),
      transport: new FakeTransport(() => jsonResponse(200, {}))
    });

    const session = await service.getSession(ORG);

    assert.equal(session.accessToken, "00D!AQ_FRESH_TOKEN");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].slice(0, 3), ["org", "auth", "show-access-token"]);
    assert.equal(calls[1].includes("--target-org"), true);
    assert.equal(calls[1].includes("dev"), true);
  });

  it("does not invoke the fallback when org display already provides a token", async () => {
    let calls = 0;
    const service = new OrgService({
      cli: cliRouting(() => {
        calls += 1;
        return displayPayload();
      }),
      transport: new FakeTransport(() => jsonResponse(200, {}))
    });

    const session = await service.getSession(ORG);

    assert.equal(session.accessToken, "00D000000000001!AQ_SENTINEL_TOKEN");
    assert.equal(calls, 1);
  });

  it("reports an unusable CLI token when the fallback command fails", async () => {
    const service = new OrgService({
      cli: cliRouting((args) => {
        if (args[0] === "org" && args[1] === "display") {
          return displayPayload({ accessToken: REDACTED });
        }
        throw Object.assign(new Error("command not found"), { code: 2 });
      }),
      transport: new FakeTransport(() => jsonResponse(200, {}))
    });

    await assert.rejects(
      service.getSession(ORG),
      (error: unknown) =>
        error instanceof AuthError &&
        /access token/i.test(error.userMessage) &&
        /Update the Salesforce CLI/i.test(error.userMessage)
    );
  });

  it("refuses to continue when the alias resolves to a different username", async () => {
    const service = new OrgService({
      cli: cliReturning(displayPayload({ username: "someone-else@example.com" })),
      transport: new FakeTransport(() => jsonResponse(200, {}))
    });
    await assert.rejects(
      service.getSession(ORG),
      (error: unknown) => error instanceof AppError && error.code === "ORG_MISMATCH"
    );
  });

  it("refuses to continue when the org ID changes", async () => {
    const service = new OrgService({
      cli: cliReturning(displayPayload({ id: "00D000000000099" })),
      transport: new FakeTransport(() => jsonResponse(200, {}))
    });
    await assert.rejects(
      service.getSession(ORG),
      (error: unknown) => error instanceof AppError && error.code === "ORG_MISMATCH"
    );
  });

  it("rejects an expired CLI session before making an API call", async () => {
    const service = new OrgService({
      cli: cliReturning(
        displayPayload({ connectedStatus: "Unable to refresh session: expired access/refresh token" })
      ),
      transport: new FakeTransport(() => jsonResponse(200, {}))
    });
    await assert.rejects(service.getSession(ORG), (error: unknown) => error instanceof AuthError);
  });
});

describe("OrgService.assertSession", () => {
  it("probes the API with the selected API version", async () => {
    const transport = new FakeTransport((request) => {
      assert.equal(requestPathname(request), "/services/data/v66.0/limits");
      return jsonResponse(200, {});
    });
    const service = new OrgService({
      cli: cliReturning(displayPayload()),
      transport,
      configuredApiVersion: () => "66.0"
    });
    const session = await service.assertSession(ORG);
    assert.equal(session.org.username, ORG.username);
    assert.equal(transport.requests.length, 1);
    assert.equal(transport.requests[0].headers?.Authorization?.startsWith("Bearer "), true);
  });

  it("wraps a 401 into an authentication error", async () => {
    const transport = new FakeTransport(() =>
      jsonResponse(401, [{ message: "Invalid session", errorCode: "INVALID_SESSION_ID" }])
    );
    const service = new OrgService({
      cli: cliReturning(displayPayload()),
      transport,
      configuredApiVersion: () => "66.0"
    });
    await assert.rejects(service.assertSession(ORG), (error: unknown) => error instanceof AuthError);
  });

  it("treats a 403 as a valid session with insufficient API access", async () => {
    const transport = new FakeTransport(() =>
      jsonResponse(403, [{ message: "Forbidden", errorCode: "INSUFFICIENT_ACCESS" }])
    );
    const service = new OrgService({
      cli: cliReturning(displayPayload()),
      transport,
      configuredApiVersion: () => "66.0"
    });
    const session = await service.assertSession(ORG);
    assert.equal(session.org.username, ORG.username);
  });
});
