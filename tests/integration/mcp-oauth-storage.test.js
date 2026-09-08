import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createHash } from "node:crypto";
import { createAccessStore } from "../../server/features/mcp/access-store.js";
import { createMcpAccess } from "../../server/features/mcp/access-service.js";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-storage-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("OAuth private storage bounds pending requests and prunes expired capacity", (t) => {
  const directory = fixture(t);
  let now = 1000;
  const store = createAccessStore(directory, () => now);
  t.after(() => store.close());
  for (let i = 0; i < 1000; i++) store.put("pending", String(i), { expiresAt: 2000 });
  assert.throws(() => store.put("pending", "overflow", { expiresAt: 3000 }), /capacity/);
  assert.equal(store.list("pending").length, 1000);
  now = 2001;
  store.put("pending", "new", { expiresAt: 3000 });
  assert.equal(store.list("pending").length, 1);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  for (const file of fs.readdirSync(directory))
    assert.equal(fs.statSync(path.join(directory, file)).mode & 0o777, 0o600);
});

test("OAuth storage rolls back partial token writes on capacity failures", (t) => {
  const directory = fixture(t);
  const store = createAccessStore(directory, () => 1000);
  t.after(() => store.close());
  for (let i = 0; i < 1000; i++) store.put("pending", String(i), { expiresAt: 2000 });
  assert.throws(
    () =>
      store.transaction(() => {
        store.put("access", "token-hash", { expiresAt: 2000 });
        store.put("pending", "overflow", { expiresAt: 2000 });
      }),
    /capacity/,
  );
  assert.equal(store.get("access", "token-hash"), null);
});

test("OAuth consent detects removed resource IDs and emits only bounded lifecycle events", (t) => {
  const directory = fixture(t);
  const events = [];
  let choices = [{ id: "p1", name: "Private project" }];
  const access = createMcpAccess({
    directory,
    publicUrl: "https://agent.example",
    now: () => 1000,
    resolveResources: () => ({ projects: choices }),
    onEvent: (event) => events.push(event),
  });
  const store = createAccessStore(directory, () => 1000);
  t.after(() => {
    access.close();
    store.close();
  });
  const id = "a".repeat(43);
  store.put("pending", id, {
    id,
    clientId: "client",
    clientName: "Untrusted name",
    scopes: ["catalog:read"],
    resource: "https://agent.example/mcp",
    redirectUri: "http://127.0.0.1/cb",
    challenge: "challenge",
    expiresAt: 2000,
  });
  const selection = {
    scopes: ["catalog:read"],
    projectIds: ["p1"],
    accountIds: [],
    connectionIds: [],
  };
  choices = [];
  assert.throws(() => access.approve(id, selection), /available resources/);
  choices = [{ id: "p1", name: "Private project" }];
  access.approve(id, selection);
  const grantId = access.listGrants().grants[0].id;
  access.revoke(grantId);
  assert.deepEqual(events, [
    { action: "mcp.accepted", grantId, clientId: "client", resourceCount: 1 },
    { action: "mcp.revoked", grantId, clientId: "client", reason: "owner" },
  ]);
});

test("OAuth refuses symlinked storage files", (t) => {
  const directory = fixture(t);
  const target = path.join(directory, "other.sqlite");
  fs.writeFileSync(target, "private");
  fs.symlinkSync(target, path.join(directory, "access.sqlite"));
  assert.throws(() => createAccessStore(directory, Date.now), /Unsafe database/);
  assert.equal(fs.readFileSync(target, "utf8"), "private");
});

test("OAuth enables only explicit-port loopback HTTP origins for local access", (t) => {
  const directory = fixture(t);
  for (const publicUrl of [
    "http://127.0.0.1:32123",
    "http://localhost:32123",
    "http://[::1]:32123",
  ]) {
    const access = createMcpAccess({ directory, publicUrl });
    assert.equal(access.status().available, true);
    assert.equal(access.status().mcpUrl, publicUrl + "/mcp");
    access.close();
  }
  for (const publicUrl of [
    "http://192.168.1.2:32123",
    "http://machine.example:32123",
    "http://127.0.0.2:32123",
    "http://localhost",
    "http://127.0.0.1:32123/path",
  ]) {
    assert.throws(() => createMcpAccess({ directory, publicUrl }), /origin/);
  }
});

test("Loopback HTTP OAuth advertises and enforces its local resource through token exchange", async (t) => {
  const directory = fixture(t);
  const access = createMcpAccess({ directory, publicUrl: "http://127.0.0.1:32123" });
  const app = express();
  app.use(access.publicRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    access.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const resource = "http://127.0.0.1:32123/mcp";
  const metadata = await (
    await fetch(base + "/.well-known/oauth-authorization-server")
  ).json();
  assert.equal(metadata.issuer, "http://127.0.0.1:32123/");
  const registration = await fetch(base + "/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://localhost:49152/callback"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const verifier = "a".repeat(64);
  const parameters = {
    client_id: client.client_id,
    redirect_uri: "http://localhost:49152/callback",
    response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource,
    scope: "catalog:read",
  };
  const authorization = await fetch(
    base + "/authorize?" + new URLSearchParams(parameters),
    { redirect: "manual" },
  );
  assert.equal(authorization.status, 302);
  const id = new URL(authorization.headers.get("location")).searchParams.get(
    "authorization",
  );
  const callback = access.approve(id, {
    scopes: ["catalog:read"],
    projectIds: [],
    accountIds: [],
    connectionIds: [],
  });
  const response = await fetch(base + "/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: client.client_id,
      grant_type: "authorization_code",
      code: new URL(callback.redirectUrl).searchParams.get("code"),
      redirect_uri: parameters.redirect_uri,
      code_verifier: verifier,
      resource,
    }),
  });
  assert.equal(response.status, 200);
  const tokens = await response.json();
  const checked = access.checkAccessToken(tokens.access_token);
  assert.equal(checked.resource.href, resource);
  assert.equal(typeof checked.then, "undefined");
  assert.deepEqual((await access.verifyAccessToken(tokens.access_token)).scopes, [
    "catalog:read",
  ]);
});
