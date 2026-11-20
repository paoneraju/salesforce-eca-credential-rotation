import * as assert from "node:assert/strict";
import {
  MIN_API_VERSION_MAJOR,
  apiVersionMajor,
  isSupportedApiVersion,
  normalizeApiVersion,
  pickUsableVersion,
  selectHighestVersion
} from "../core/api/apiVersion";

describe("apiVersion", () => {
  it("normalizes accepted version formats", () => {
    assert.equal(normalizeApiVersion("65.0"), "v65.0");
    assert.equal(normalizeApiVersion("v66.0"), "v66.0");
    assert.equal(normalizeApiVersion("  V67.0 "), "v67.0");
    assert.equal(normalizeApiVersion("64"), undefined);
    assert.equal(normalizeApiVersion("v65.1"), undefined);
    assert.equal(normalizeApiVersion(""), undefined);
  });

  it("enforces the minimum supported version", () => {
    assert.equal(MIN_API_VERSION_MAJOR, 65);
    assert.equal(isSupportedApiVersion("v65.0"), true);
    assert.equal(isSupportedApiVersion("v64.0"), false);
    assert.equal(isSupportedApiVersion("garbage"), false);
    assert.equal(apiVersionMajor("v68.0"), 68);
  });

  it("selects the highest discovered version", () => {
    assert.equal(selectHighestVersion(["v64.0", "v66.0", "v65.0", "bad"]), "v66.0");
    assert.equal(selectHighestVersion([]), undefined);
  });

  it("prefers an explicit configured version", () => {
    assert.deepEqual(
      pickUsableVersion({ configured: "v66.0", discovered: ["v68.0"], orgApiVersion: "68.0" }),
      { version: "v66.0", source: "configured" }
    );
  });

  it("falls back to discovery and then the org API version", () => {
    assert.deepEqual(pickUsableVersion({ discovered: ["v64.0", "v67.0"], orgApiVersion: "66.0" }), {
      version: "v67.0",
      source: "discovered"
    });
    assert.deepEqual(pickUsableVersion({ discovered: ["v64.0"], orgApiVersion: "66.0" }), {
      version: "v66.0",
      source: "org"
    });
  });

  it("rejects unsupported or missing versions", () => {
    assert.throws(() => pickUsableVersion({ configured: "v64.0" }), /v65\.0 or later/);
    assert.throws(() => pickUsableVersion({ discovered: ["v64.0"], orgApiVersion: "64.0" }), /v65\.0/);
    assert.throws(() => pickUsableVersion({ configured: "nonsense" }), /Invalid API version/);
  });
});
