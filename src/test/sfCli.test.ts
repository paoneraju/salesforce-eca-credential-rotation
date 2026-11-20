import * as assert from "node:assert/strict";
import { AppError } from "../core/errors";
import { SfCli, assertSafeOrgRef, parseCliJson, stripAnsi } from "../core/cli/sfCli";
import type { CliExecError, ExecFileFn } from "../core/cli/sfCli";

describe("sfCli", () => {
  it("parses direct JSON output", () => {
    const parsed = parseCliJson<{ status: number }>('{"status":0}');
    assert.deepEqual(parsed, { status: 0 });
  });

  it("strips ANSI and extracts JSON printed after CLI warnings", () => {
    const raw = "\u001b[33mWarning: update available\u001b[0m\n› some note\n{\"status\":0,\"result\":[]}";
    assert.equal(stripAnsi(raw).includes("\u001b"), false);
    assert.deepEqual(parseCliJson<{ result: unknown[] }>(raw), { status: 0, result: [] });
  });

  it("throws a typed error for empty or invalid output", () => {
    assert.throws(
      () => parseCliJson("   "),
      (error: unknown) => error instanceof AppError && error.code === "CLI_INVALID_OUTPUT"
    );
    assert.throws(
      () => parseCliJson("not json at all"),
      (error: unknown) => error instanceof AppError && error.code === "CLI_INVALID_OUTPUT"
    );
  });

  it("rejects unsafe org references", () => {
    assert.equal(assertSafeOrgRef("my-alias"), "my-alias");
    assert.throws(
      () => assertSafeOrgRef("--help"),
      (error: unknown) => error instanceof AppError && error.code === "VALIDATION"
    );
    assert.throws(
      () => assertSafeOrgRef("bad\u0000ref"),
      (error: unknown) => error instanceof AppError && error.code === "VALIDATION"
    );
  });

  it("invokes execFile with an argument array and a hard timeout", async () => {
    let captured:
      | { file: string; args: readonly string[]; timeout: number; env: NodeJS.ProcessEnv }
      | undefined;
    const runner: ExecFileFn = (file, args, options, callback) => {
      captured = { file, args, timeout: options.timeout, env: options.env };
      callback(null, '{"status":0,"result":{}}', "");
    };
    const cli = new SfCli({ sfPath: "/opt/sf", timeoutMs: 12345, runner });
    const result = await cli.runJson<{ status: number }>([
      "org",
      "display",
      "--target-org",
      "my alias"
    ]);

    assert.equal(result.value.status, 0);
    assert.equal(captured?.file, "/opt/sf");
    assert.deepEqual(captured?.args, ["org", "display", "--target-org", "my alias"]);
    assert.equal(captured?.timeout, 12345);
    assert.equal(captured?.env.SF_DISABLE_TELEMETRY, "true");
    assert.equal(captured?.env.NO_COLOR, "1");
  });

  it("maps a missing executable to CLI_NOT_FOUND", async () => {
    const runner: ExecFileFn = (_file, _args, _options, callback) => {
      const error = Object.assign(new Error("spawn sf ENOENT"), { code: "ENOENT" });
      callback(error as CliExecError, "", "");
    };
    const cli = new SfCli({ sfPath: "sf", timeoutMs: 5000, runner });
    await assert.rejects(
      cli.run(["org", "list", "--json"]),
      (error: unknown) => error instanceof AppError && error.code === "CLI_NOT_FOUND"
    );
  });

  it("maps a timeout to CLI_TIMEOUT", async () => {
    const runner: ExecFileFn = (_file, _args, _options, callback) => {
      const error = Object.assign(new Error("killed"), { killed: true, code: "ETIMEDOUT" });
      callback(error as CliExecError, "", "");
    };
    const cli = new SfCli({ sfPath: "sf", timeoutMs: 5000, runner });
    await assert.rejects(
      cli.run(["org", "list", "--json"]),
      (error: unknown) => error instanceof AppError && error.code === "CLI_TIMEOUT"
    );
  });

  it("does not expose secrets from a CLI error payload", async () => {
    const runner: ExecFileFn = (_file, _args, _options, callback) => {
      const error = Object.assign(new Error("failed"), { code: 1 });
      callback(
        error as CliExecError,
        JSON.stringify({ status: 1, message: "Bad request access_token=00Dxxx!AQyyy" }),
        ""
      );
    };
    const cli = new SfCli({ sfPath: "sf", timeoutMs: 5000, runner });
    await assert.rejects(cli.run(["org", "display"]), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.ok(!error.userMessage.includes("00Dxxx"));
      assert.ok(error.userMessage.includes("[REDACTED]"));
      return true;
    });
  });
});
