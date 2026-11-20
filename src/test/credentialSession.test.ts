import * as assert from "node:assert/strict";
import { CredentialSession } from "../core/credentials/credentialSession";
import type { StagedCredentialSecret } from "../core/types";

const SCOPE = {
  orgId: "00D000000000001",
  orgUsername: "admin@example.com",
  appIdentifier: "0xI000000000000001",
  consumerId: "C000000000000001"
};

const SECRET: StagedCredentialSecret = {
  stagedCredentialId: "S000000000000001",
  clientId: "CLIENT_ID_SENTINEL",
  clientSecret: "CLIENT_SECRET_SENTINEL",
  state: "active",
  retrievedAt: new Date().toISOString()
};

describe("CredentialSession", () => {
  it("holds a credential only for the matching scope", () => {
    const session = new CredentialSession({ ttlMs: 60_000 });
    session.set(SCOPE, SECRET);

    const held = session.get(SCOPE);
    assert.equal(held?.clientSecret, "CLIENT_SECRET_SENTINEL");
    assert.equal(session.has(SCOPE), true);
    assert.equal(session.has({ ...SCOPE, consumerId: "C000000000000002" }), false);
    assert.equal(session.get({ ...SCOPE, appIdentifier: "0xI000000000000002" }), undefined);
  });

  it("never serializes the secret", () => {
    const session = new CredentialSession({ ttlMs: 60_000 });
    session.set(SCOPE, SECRET);
    assert.equal(JSON.stringify(session), "null");
    assert.equal(JSON.stringify({ credentials: session }).includes("SENTINEL"), false);
  });

  it("notifies listeners on set and clear", () => {
    let changes = 0;
    const session = new CredentialSession({ ttlMs: 60_000, onChange: () => (changes += 1) });
    const listener = session.addListener(() => (changes += 1));

    session.set(SCOPE, SECRET);
    assert.equal(changes, 2);

    listener.dispose();
    session.clear();
    assert.equal(changes, 3);
    assert.equal(session.has(), false);
  });

  it("expires credentials and fires a change notification", async () => {
    let changes = 0;
    const session = new CredentialSession({ ttlMs: 25, onChange: () => (changes += 1) });
    session.set(SCOPE, SECRET);
    assert.equal(session.has(), true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(session.has(), false);
    assert.equal(session.get(SCOPE), undefined);
    assert.ok(changes >= 2);
  });

  it("clears the previous credential when a new one is set", () => {
    const session = new CredentialSession({ ttlMs: 60_000 });
    session.set(SCOPE, SECRET);
    const other = { ...SCOPE, consumerId: "C000000000000002" };
    session.set(other, { ...SECRET, stagedCredentialId: "S000000000000002" });
    assert.equal(session.get(SCOPE), undefined);
    assert.equal(session.get(other)?.stagedCredentialId, "S000000000000002");
  });
});
