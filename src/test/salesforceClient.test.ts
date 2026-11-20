import * as assert from "node:assert/strict";
import { ApiError, AppError } from "../core/errors";
import { OrgSession, type SalesforceOrg } from "../core/types";
import {
  SalesforceClient,
  parseSalesforceError,
  stagedCredentialsPath
} from "../core/api/salesforceClient";
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

function makeClient(
  transport: FakeTransport,
  apiVersion = "66.0"
): SalesforceClient {
  return new SalesforceClient(
    new OrgSession({ org: ORG, accessToken: "TOKEN_SENTINEL", apiVersion: "66.0" }),
    { transport, configuredApiVersion: apiVersion, timeoutMs: 1000 }
  );
}

describe("SalesforceClient", () => {
  it("uses the configured API version and sends a bearer token", async () => {
    const transport = new FakeTransport((request) => {
      assert.equal(requestPathname(request), "/services/data/v66.0/limits");
      assert.equal(request.headers?.Authorization, "Bearer TOKEN_SENTINEL");
      return jsonResponse(200, { DailyApiRequests: {} });
    });
    const result = await makeClient(transport).get<{ DailyApiRequests: unknown }>("/limits");
    assert.equal(result.status, 200);
  });

  it("auto-detects the highest supported version", async () => {
    const paths: string[] = [];
    const transport = new FakeTransport((request) => {
      const path = requestPathname(request);
      paths.push(path);
      if (path === "/services/data/") {
        return jsonResponse(200, [{ version: "64.0" }, { version: "68.0" }]);
      }
      return jsonResponse(200, { ok: true });
    });
    const client = new SalesforceClient(
      new OrgSession({ org: ORG, accessToken: "TOKEN_SENTINEL" }),
      { transport, timeoutMs: 1000 }
    );
    assert.equal(await client.getApiVersion(), "v68.0");
    await client.get("/limits");
    assert.deepEqual(paths, ["/services/data/", "/services/data/v68.0/limits"]);
  });

  it("rejects an invalid or unsupported configured version", async () => {
    const transport = new FakeTransport(() => jsonResponse(200, {}));
    await assert.rejects(
      makeClient(transport, "not-a-version").getApiVersion(),
      (error: unknown) => error instanceof AppError && error.code === "API_VERSION_UNSUPPORTED"
    );
    await assert.rejects(
      makeClient(transport, "v64.0").getApiVersion(),
      (error: unknown) => error instanceof AppError && error.code === "API_VERSION_UNSUPPORTED"
    );
  });

  it("maps a 401 to API_AUTH", async () => {
    const transport = new FakeTransport(() =>
      jsonResponse(401, [{ message: "Session expired", errorCode: "INVALID_SESSION_ID" }])
    );
    await assert.rejects(makeClient(transport).get("/limits"), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 401);
      assert.equal(error.code, "API_AUTH");
      return true;
    });
  });

  it("maps a 403 with a Salesforce message", async () => {
    const transport = new FakeTransport(() =>
      jsonResponse(403, [{ message: "No access to External Client Apps", errorCode: "INSUFFICIENT_ACCESS" }])
    );
    await assert.rejects(makeClient(transport).get("/limits"), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "API_PERMISSION");
      assert.match(error.userMessage, /denied access/);
      assert.match(error.userMessage, /No access to External Client Apps/);
      assert.match(error.remediation ?? "", /Allow access to External Client App consumer secrets/);
      return true;
    });
  });

  it("maps a 404 to API_NOT_FOUND", async () => {
    const transport = new FakeTransport(() => jsonResponse(404, [{ message: "Not found" }]));
    await assert.rejects(makeClient(transport).get("/apps/oauth/usage"), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "API_NOT_FOUND");
      return true;
    });
  });

  it("rejects unsafe API paths", async () => {
    const transport = new FakeTransport(() => jsonResponse(200, {}));
    await assert.rejects(
      makeClient(transport).requestAbsolute("GET", "/services/data/../secret"),
      (error: unknown) => error instanceof AppError && error.code === "INTERNAL"
    );
    await assert.rejects(
      makeClient(transport).get("limits"),
      (error: unknown) => error instanceof AppError && error.code === "INTERNAL"
    );
  });

  it("encodes staged credential path segments", () => {
    assert.equal(
      stagedCredentialsPath("0xI000", "consumer/id", "staged id"),
      "/apps/oauth/credentials/0xI000/consumer%2Fid/staged/staged%20id"
    );
  });

  it("parses array and object Salesforce errors", () => {
    assert.deepEqual(parseSalesforceError('[{"message":"Boom","errorCode":"BAD"}]'), {
      message: "Boom",
      code: "BAD"
    });
    assert.deepEqual(
      parseSalesforceError('{"error":"invalid_client","error_description":"Bad secret"}'),
      { message: "Bad secret", code: "invalid_client" }
    );
    assert.equal(parseSalesforceError("plain text error").message, "plain text error");
    assert.equal(parseSalesforceError("<html>bad gateway</html>").message, "Salesforce returned an error response.");
  });
});
