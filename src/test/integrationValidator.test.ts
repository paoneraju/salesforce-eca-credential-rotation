import * as assert from "node:assert/strict";
import { TransportError } from "../core/api/http";
import { validateClientCredentials } from "../core/validation/integrationValidator";
import { FakeTransport, jsonResponse } from "./helpers";

const BASE = {
  instanceUrl: "https://example.my.salesforce.com",
  clientId: "CLIENT_ID_SENTINEL",
  clientSecret: "CLIENT_SECRET_SENTINEL",
  timeoutMs: 1000
};

describe("validateClientCredentials", () => {
  it("reports success and discards the issued token", async () => {
    const transport = new FakeTransport(() =>
      jsonResponse(200, {
        access_token: "00D000000000001!AQ_TOKEN_SENTINEL",
        token_type: "Bearer"
      })
    );
    const result = await validateClientCredentials({ ...BASE, transport });
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(JSON.stringify(result).includes("TOKEN_SENTINEL"), false);
    assert.equal(JSON.stringify(result).includes("CLIENT_SECRET_SENTINEL"), false);
    assert.equal(transport.requests[0].method, "POST");
    assert.match(transport.requests[0].url, /\/services\/oauth2\/token$/);
    assert.match(transport.requests[0].body ?? "", /grant_type=client_credentials/);
  });

  it("explains invalid_client without leaking the secret", async () => {
    const transport = new FakeTransport(() =>
      jsonResponse(400, {
        error: "invalid_client",
        error_description: "invalid client credentials CLIENT_SECRET_SENTINEL"
      })
    );
    const result = await validateClientCredentials({ ...BASE, transport });
    assert.equal(result.ok, false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    assert.equal(result.errorCode, "invalid_client");
    assert.match(result.detail, /rejected the client credentials/);
    assert.equal(JSON.stringify(result).includes("CLIENT_SECRET_SENTINEL"), false);
  });

  it("explains a missing Run-As user on invalid_grant", async () => {
    const transport = new FakeTransport(() =>
      jsonResponse(400, {
        error: "invalid_grant",
        error_description: "no client credentials user enabled"
      })
    );
    const result = await validateClientCredentials({ ...BASE, transport });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorCode, "invalid_grant");
      assert.match(result.detail, /Run-As user/);
    }
  });

  it("reports a success status without an access token as inconclusive", async () => {
    const transport = new FakeTransport(() => jsonResponse(200, { token_type: "Bearer" }));
    const result = await validateClientCredentials({ ...BASE, transport });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.detail, /no access token/);
    }
  });

  it("distinguishes a timeout from an authentication failure", async () => {
    const transport = new FakeTransport(() => {
      throw new TransportError("TIMEOUT", "timed out");
    });
    const result = await validateClientCredentials({ ...BASE, transport });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 0);
      assert.match(result.detail, /timed out/);
    }
  });

  it("rejects an instance URL that is not Salesforce", async () => {
    await assert.rejects(
      validateClientCredentials({
        ...BASE,
        instanceUrl: "https://example.net",
        transport: new FakeTransport(() => jsonResponse(200, {}))
      }),
      /unexpected host/
    );
  });
});
