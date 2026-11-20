import * as assert from "node:assert/strict";
import { redact, redactObject, isSensitiveKey } from "../core/redact";

describe("redact", () => {
  it("redacts key/value secrets", () => {
    const output = redact(
      "client_secret=abc123 refresh_token: xyz789 access_token=00Dxxxyyy!AQzzz password=hunter2"
    );
    assert.ok(!output.includes("abc123"));
    assert.ok(!output.includes("xyz789"));
    assert.ok(!output.includes("hunter2"));
    assert.ok(output.includes("[REDACTED]"));
  });

  it("redacts bearer tokens and SFDX auth URLs", () => {
    const output = redact(
      "Authorization: Bearer abcdefghijklmnop force://PlatformCLI::abc@example.my.salesforce.com"
    );
    assert.ok(!output.includes("abcdefghijklmnop"));
    assert.ok(!output.includes("force://"));
    assert.ok(output.includes("Bearer [REDACTED]"));
  });

  it("leaves ordinary text intact", () => {
    const input = "The External Client App was staged and rotation was verified.";
    assert.equal(redact(input), input);
  });

  it("identifies sensitive keys", () => {
    assert.equal(isSensitiveKey("accessToken"), true);
    assert.equal(isSensitiveKey("client_secret"), true);
    assert.equal(isSensitiveKey("sfdxAuthUrl"), true);
    assert.equal(isSensitiveKey("developerName"), false);
  });

  it("deep-copies and redacts object keys", () => {
    const result = redactObject({
      developerName: "My_App",
      accessToken: "00Dxxx!AQ",
      nested: { clientSecret: "shh", count: 2 }
    }) as Record<string, unknown>;
    assert.equal(result.developerName, "My_App");
    assert.equal(result.accessToken, "[REDACTED]");
    assert.deepEqual(result.nested, { clientSecret: "[REDACTED]", count: 2 });
  });
});
