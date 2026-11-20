import * as assert from "node:assert/strict";
import { EcaApi } from "../core/api/ecaApi";
import { SalesforceClient } from "../core/api/salesforceClient";
import { AppError } from "../core/errors";
import { OrgSession, type SalesforceOrg } from "../core/types";
import {
  FakeTransport,
  emptyResponse,
  jsonResponse,
  parseRequestBody,
  requestPath,
  requestPathname
} from "./helpers";

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

const APP = "0xI000000000000001";
const APP_PACKAGED = "0xI000000000000002";
const CONSUMER = "C000000000000001";
const CONSUMER_PACKAGED = "C000000000000002";
const STAGED_ACTIVE = "S000000000000001";
const STAGED_ROTATED = "S000000000000002";
const BASE = "/services/data/v66.0";

interface Recorder {
  rotateBody?: unknown;
  deleteCalled: boolean;
  stageCalled: boolean;
}

function makeApi(options?: { omitSecret?: boolean }): { api: EcaApi; transport: FakeTransport; recorder: Recorder } {
  const recorder: Recorder = { deleteCalled: false, stageCalled: false };
  const transport = new FakeTransport((request) => {
    const path = requestPathname(request);

    if (path === `${BASE}/apps/oauth/usage`) {
      return jsonResponse(200, {
        apps: [
          {
            identifier: APP,
            developerName: "Local_App",
            description: "A local app",
            isFromPackage: false,
            accessTokenFormat: "JWT"
          },
          {
            identifier: APP_PACKAGED,
            developerName: "Packaged_App",
            isFromPackage: true
          }
        ]
      });
    }

    if (path === `${BASE}/apps/oauth/credentials/${APP}` && request.method === "GET") {
      return jsonResponse(200, {
        consumers: [{ id: CONSUMER, key: "CURRENT_CLIENT_ID", name: "Local App Consumer" }]
      });
    }
    if (path === `${BASE}/apps/oauth/credentials/${APP_PACKAGED}` && request.method === "GET") {
      return jsonResponse(200, {
        consumers: [{ id: CONSUMER_PACKAGED, key: "PACKAGED_CLIENT_ID", name: "Packaged Consumer" }]
      });
    }

    if (path === `${BASE}/apps/oauth/credentials/${APP}/${CONSUMER}/staged`) {
      if (request.method === "POST") {
        recorder.stageCalled = true;
        return jsonResponse(201, {
          stagedCredentials: [
            {
              id: STAGED_ACTIVE,
              state: "active",
              key: "NEW_CLIENT_ID",
              secret: "NEW_CLIENT_SECRET",
              createdDate: "2026-01-01T00:00:00.000Z",
              expirationDate: "2026-01-02T00:00:00.000Z"
            }
          ]
        });
      }
      return jsonResponse(200, {
        stagedCredentials: [
          {
            id: STAGED_ACTIVE,
            state: "active",
            key: "NEW_CLIENT_ID",
            secret: options?.omitSecret ? undefined : "NEW_CLIENT_SECRET",
            createdDate: "2026-01-01T00:00:00.000Z"
          },
          {
            id: STAGED_ROTATED,
            state: "rotated",
            key: "OLD_CLIENT_ID",
            secret: "OLD_CLIENT_SECRET",
            createdDate: "2025-12-01T00:00:00.000Z"
          }
        ]
      });
    }

    if (path === `${BASE}/apps/oauth/credentials/${APP}/${CONSUMER}/staged/${STAGED_ACTIVE}`) {
      if (request.method === "PATCH") {
        recorder.rotateBody = parseRequestBody(request);
        return jsonResponse(200, {
          stagedCredentials: [{ id: STAGED_ACTIVE, state: "rotated" }]
        });
      }
      if (request.method === "DELETE") {
        recorder.deleteCalled = true;
        return emptyResponse(204);
      }
    }

    if (path === `${BASE}/apps/oauth/credentials/${APP}/${CONSUMER}` && request.method === "GET") {
      return jsonResponse(200, { id: CONSUMER, key: "NEW_CLIENT_ID" });
    }

    return jsonResponse(404, [{ message: `Unhandled ${request.method} ${path}` }]);
  });

  const client = new SalesforceClient(
    new OrgSession({ org: ORG, accessToken: "TOKEN_SENTINEL", apiVersion: "66.0" }),
    { transport, configuredApiVersion: "66.0", timeoutMs: 1000 }
  );
  return { api: new EcaApi(client), transport, recorder };
}

describe("EcaApi", () => {
  it("discovers apps and marks packaged apps as unsupported", async () => {
    const { api } = makeApi();
    const result = await api.listEcas("dev");

    assert.equal(result.ecas.length, 2);
    const local = result.ecas.find((eca) => eca.identifier === APP);
    assert.equal(local?.supported, true);
    assert.equal(local?.consumer?.id, CONSUMER);
    assert.equal(local?.consumer?.key, "CURRENT_CLIENT_ID");
    assert.equal(local?.name, "Local App Consumer");

    const packaged = result.ecas.find((eca) => eca.identifier === APP_PACKAGED);
    assert.equal(packaged?.supported, false);
    assert.match(packaged?.unsupportedReason ?? "", /Packaged/);
  });

  it("stages credentials without leaking the returned secret", async () => {
    const { api, recorder } = makeApi();
    const result = await api.stageCredentials(APP, CONSUMER);

    assert.equal(recorder.stageCalled, true);
    assert.equal(result.httpStatus, 201);
    assert.equal(result.staged.id, STAGED_ACTIVE);
    assert.equal(result.staged.state, "active");
    assert.equal(Object.prototype.hasOwnProperty.call(result.staged, "secret"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result.staged, "key"), false);
  });

  it("lists staged credentials as metadata only", async () => {
    const { api } = makeApi();
    const staged = await api.listStagedCredentials(APP, CONSUMER);
    assert.equal(staged.length, 2);
    assert.equal(staged[0].id, STAGED_ACTIVE);
    assert.equal(Object.prototype.hasOwnProperty.call(staged[0], "secret"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(staged[0], "key"), false);
  });

  it("retrieves the matching staged credential values", async () => {
    const { api } = makeApi();
    const secret = await api.retrieveStagedCredential(APP, CONSUMER, STAGED_ACTIVE);
    assert.equal(secret.stagedCredentialId, STAGED_ACTIVE);
    assert.equal(secret.clientId, "NEW_CLIENT_ID");
    assert.equal(secret.clientSecret, "NEW_CLIENT_SECRET");
    assert.equal(secret.state, "active");
  });

  it("fails clearly when the org does not return the staged secret", async () => {
    const { api } = makeApi({ omitSecret: true });
    await assert.rejects(
      api.retrieveStagedCredential(APP, CONSUMER, STAGED_ACTIVE),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, "UNSUPPORTED");
        assert.match(error.userMessage, /Allow access to External Client App consumer secrets/);
        return true;
      }
    );
  });

  it("rejects an unknown staged credential ID", async () => {
    const { api } = makeApi();
    await assert.rejects(
      api.retrieveStagedCredential(APP, CONSUMER, "N000000000000001"),
      (error: unknown) => error instanceof AppError && error.code === "VALIDATION"
    );
  });

  it("rotates with the documented command payload", async () => {
    const { api, recorder } = makeApi();
    const result = await api.rotateCredential(APP, CONSUMER, STAGED_ACTIVE);
    assert.deepEqual(recorder.rotateBody, { command: "rotate" });
    assert.equal(result.httpStatus, 200);
    assert.equal(result.staged.state, "rotated");
  });

  it("deletes a staged credential", async () => {
    const { api, recorder } = makeApi();
    const status = await api.deleteStagedCredential(APP, CONSUMER, STAGED_ACTIVE);
    assert.equal(status, 204);
    assert.equal(recorder.deleteCalled, true);
  });

  it("reads the active consumer key", async () => {
    const { api } = makeApi();
    assert.equal(await api.getActiveConsumerKey(APP, CONSUMER), "NEW_CLIENT_ID");
  });

  it("normalizes absolute pagination URLs without duplicating the version prefix", async () => {
    const transport = new FakeTransport((request) => {
      const url = new URL(request.url);
      if (url.pathname === `${BASE}/apps/oauth/usage`) {
        if (url.searchParams.get("page") === "0") {
          return jsonResponse(200, {
            apps: [{ identifier: APP, developerName: "Local_App", isFromPackage: false }],
            nextPageUrl: `https://example.my.salesforce.com${BASE}/apps/oauth/usage?page=1&pageSize=100`
          });
        }
        return jsonResponse(200, {
          apps: [{ identifier: APP_PACKAGED, developerName: "Packaged_App", isFromPackage: true }]
        });
      }
      if (
        url.pathname === `${BASE}/apps/oauth/credentials/${APP}` ||
        url.pathname === `${BASE}/apps/oauth/credentials/${APP_PACKAGED}`
      ) {
        return jsonResponse(200, { consumers: [] });
      }
      return jsonResponse(404, [{ message: `Unhandled ${request.method} ${url.pathname}` }]);
    });
    const client = new SalesforceClient(
      new OrgSession({ org: ORG, accessToken: "TOKEN_SENTINEL", apiVersion: "66.0" }),
      { transport, configuredApiVersion: "66.0", timeoutMs: 1000 }
    );

    const result = await new EcaApi(client).listEcas("dev");

    assert.deepEqual(
      result.ecas.map((eca) => eca.identifier).sort(),
      [APP, APP_PACKAGED].sort()
    );
    const usageRequests = transport.requests
      .map((request) => requestPath(request))
      .filter((path) => path.startsWith(`${BASE}/apps/oauth/usage`));
    assert.deepEqual(usageRequests, [
      `${BASE}/apps/oauth/usage?page=0&pageSize=100`,
      `${BASE}/apps/oauth/usage?page=1&pageSize=100`
    ]);
    assert.equal(
      transport.requests.some((request) =>
        new URL(request.url).pathname.includes("/services/data/v66.0/services/data")
      ),
      false
    );
  });

  it("stops at an empty usage page instead of following its nextPageUrl", async () => {
    const transport = new FakeTransport((request) => {
      const url = new URL(request.url);
      if (url.pathname === `${BASE}/apps/oauth/usage`) {
        if (url.searchParams.get("page") === "0") {
          return jsonResponse(200, {
            apps: [{ identifier: APP, developerName: "Local_App", isFromPackage: false }],
            nextPageUrl: `${BASE}/apps/oauth/usage?page=1&pageSize=100`
          });
        }
        return jsonResponse(200, {
          apps: [],
          nextPageUrl: `${BASE}/apps/oauth/usage?page=2&pageSize=100`
        });
      }
      if (url.pathname === `${BASE}/apps/oauth/credentials/${APP}`) {
        return jsonResponse(200, {
          consumers: [{ id: CONSUMER, key: "CURRENT_CLIENT_ID", name: "Local App Consumer" }]
        });
      }
      return jsonResponse(404, [{ message: `Unhandled ${request.method} ${url.pathname}` }]);
    });
    const client = new SalesforceClient(
      new OrgSession({ org: ORG, accessToken: "TOKEN_SENTINEL", apiVersion: "66.0" }),
      { transport, configuredApiVersion: "66.0", timeoutMs: 1000 }
    );

    const result = await new EcaApi(client).listEcas("dev");

    assert.equal(result.ecas.length, 1);
    assert.equal(result.ecas[0].identifier, APP);
    const usageRequests = transport.requests
      .map((request) => requestPath(request))
      .filter((path) => path.startsWith(`${BASE}/apps/oauth/usage`));
    assert.deepEqual(usageRequests, [
      `${BASE}/apps/oauth/usage?page=0&pageSize=100`,
      `${BASE}/apps/oauth/usage?page=1&pageSize=100`
    ]);
  });

  it("rejects invalid identifiers before making a request", async () => {
    const { api, transport } = makeApi();
    await assert.rejects(
      api.listStagedCredentials("not-an-app", CONSUMER),
      (error: unknown) => error instanceof AppError && error.code === "VALIDATION"
    );
    assert.equal(transport.requests.length, 0);
  });
});
