import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { createMcpAccess } from "../../server/features/mcp/access-service.js";
import { mcpAccessRoutes } from "../../server/http/routes/mcp-access.js";

const resource = "https://agent.example/mcp";
const redirect = "http://127.0.0.1:49152/callback";
const verifier = "a".repeat(64);
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const selection = {
  scopes: ["catalog:read", "runs:read"],
  projectIds: ["p1"],
  accountIds: ["a1"],
  connectionIds: [],
};
async function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-"));
  let now = Date.now();
  const options = {
    directory,
    publicUrl: "https://agent.example",
    now: () => now,
    resolveResources: () => ({
      projects: [{ id: "p1", name: "Project" }],
      accounts: [{ id: "a1", name: "Account" }],
      connections: [],
    }),
    ...overrides,
  };
  let access = createMcpAccess(options);
  const app = express();
  app.use((req, res, next) => access.publicRouter(req, res, next));
  app.use(express.json());
  app.use("/api", (req, res, next) =>
    req.headers["x-test-owner"] === "yes" ? next() : res.sendStatus(403),
  );
  app.use("/api", (req, res, next) =>
    mcpAccessRoutes({ mcpAccess: access })(req, res, next),
  );
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    access.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = async (route, body, owner = false) =>
    fetch(base + route, {
      method: body === undefined ? "GET" : "POST",
      redirect: "manual",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(owner ? { "x-test-owner": "yes" } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const form = (route, body) =>
    fetch(base + route, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
  const register = async (changes = {}) => {
    const res = await request("/register", {
      client_name: "Test CLI",
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...changes,
    });
    assert.equal(res.status, 201);
    return res.json();
  };
  const authorize = async (client, changes = {}) =>
    request(
      "/authorize?" +
        new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: redirect,
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "catalog:read runs:read",
          resource,
          state: "cli-state",
          ...changes,
        }),
    );
  const code = async (client) => {
    const response = await authorize(client);
    assert.equal(response.status, 302);
    const id = new URL(response.headers.get("location"), base).searchParams.get(
      "authorization",
    );
    assert.ok(id);
    const result = await request(
      `/api/mcp-access/authorizations/${id}/approve`,
      selection,
      true,
    );
    assert.equal(result.status, 200);
    const callback = new URL((await result.json()).redirectUrl);
    assert.equal(callback.searchParams.get("state"), "cli-state");
    return callback.searchParams.get("code");
  };
  const exchange = (client, value, changes = {}) =>
    form("/token", {
      client_id: client.client_id,
      grant_type: "authorization_code",
      code: value,
      code_verifier: verifier,
      redirect_uri: redirect,
      resource,
      ...changes,
    });
  return {
    request,
    form,
    register,
    authorize,
    code,
    exchange,
    directory,
    fetchFn: (url, options) => {
      const target = new URL(url);
      assert.equal(target.origin, "https://agent.example");
      return fetch(base + target.pathname + target.search, options);
    },
    access: () => access,
    advance: (ms) => {
      now += ms;
    },
    restart: () => {
      access.close();
      access = createMcpAccess(options);
    },
  };
}

test("OAuth HTTP issues restricted tokens, persists private grants and revokes them", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const authCode = await f.code(client);
  const response = await f.exchange(client, authCode);
  assert.equal(response.status, 200);
  const tokens = await response.json();
  const info = await f.access().verifyAccessToken(tokens.access_token);
  assert.equal(info.resource.href, resource);
  assert.deepEqual(info.extra.grant.projectIds, ["p1"]);
  assert.deepEqual(info.scopes, ["catalog:read", "runs:read"]);
  f.restart();
  assert.equal(
    (await f.access().verifyAccessToken(tokens.access_token)).clientId,
    client.client_id,
  );
  const grants = await (
    await f.request("/api/mcp-access/grants", undefined, true)
  ).json();
  assert.equal(grants.total, 1);
  assert.ok(!JSON.stringify(grants).includes(tokens.access_token));
  assert.ok(
    !fs
      .readFileSync(path.join(f.directory, "access.sqlite"))
      .includes(Buffer.from(tokens.refresh_token)),
  );
  assert.equal(
    (await f.request(`/api/mcp-access/grants/${info.extra.grant.id}/revoke`, {}, true))
      .status,
    200,
  );
  await assert.rejects(f.access().verifyAccessToken(tokens.access_token));
  f.restart();
  await assert.rejects(f.access().verifyAccessToken(tokens.access_token));
});

test("OAuth HTTP rejects incorrect PKCE, redirect, resource, expired and reused codes", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const authCode = await f.code(client);
  for (const changes of [
    { code_verifier: "b".repeat(64) },
    { redirect_uri: "http://127.0.0.1:49153/callback" },
    { resource: "https://other.example/mcp" },
    { resource: "" },
  ]) {
    assert.equal((await f.exchange(client, authCode, changes)).status, 400);
  }
  assert.equal((await f.exchange(client, authCode)).status, 200);
  assert.equal((await f.exchange(client, authCode)).status, 400);
  const expired = await f.code(client);
  f.advance(3 * 60_000);
  assert.equal((await f.exchange(client, expired)).status, 400);
});

test("OAuth HTTP refresh rotates, binds audience, narrows scopes and revokes family on replay", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const tokens = await (await f.exchange(client, await f.code(client))).json();
  const refresh = (token, changes = {}) =>
    f.form("/token", {
      client_id: client.client_id,
      grant_type: "refresh_token",
      refresh_token: token,
      resource,
      ...changes,
    });
  assert.equal(
    (await refresh(tokens.refresh_token, { resource: "https://wrong.example/mcp" }))
      .status,
    400,
  );
  assert.equal(
    (await refresh(tokens.refresh_token, { scope: "runs:publish" })).status,
    400,
  );
  const rotated = await (
    await refresh(tokens.refresh_token, { scope: "catalog:read" })
  ).json();
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);
  assert.deepEqual((await f.access().verifyAccessToken(rotated.access_token)).scopes, [
    "catalog:read",
  ]);
  f.restart();
  assert.equal((await refresh(tokens.refresh_token)).status, 400);
  await assert.rejects(f.access().verifyAccessToken(rotated.access_token));
  assert.equal((await refresh(rotated.refresh_token)).status, 400);
});

test("OAuth HTTP consent requires owner and rejects wildcard or elevated selections", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const res = await f.authorize(client);
  const id = new URL(
    res.headers.get("location"),
    "https://agent.example",
  ).searchParams.get("authorization");
  assert.equal((await f.request(`/api/mcp-access/authorizations/${id}`)).status, 403);
  for (const changes of [
    { projectIds: ["*"] },
    { accountIds: ["unknown"] },
    { scopes: ["runs:publish"] },
  ]) {
    assert.equal(
      (
        await f.request(
          `/api/mcp-access/authorizations/${id}/approve`,
          { ...selection, ...changes },
          true,
        )
      ).status,
      400,
    );
  }
  const denied = await f.request(`/api/mcp-access/authorizations/${id}/deny`, {}, true);
  assert.equal(
    new URL((await denied.json()).redirectUrl).searchParams.get("error"),
    "access_denied",
  );
  assert.equal(
    (await f.request(`/api/mcp-access/authorizations/${id}/approve`, selection, true))
      .status,
    404,
  );
});

test("OAuth metadata is accurate and registrations reject unsafe callback/client types", async (t) => {
  const f = await fixture(t);
  const metadata = await (
    await f.request("/.well-known/oauth-authorization-server")
  ).json();
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none"]);
  assert.deepEqual(metadata.revocation_endpoint_auth_methods_supported, ["none"]);
  assert.notEqual(metadata.client_id_metadata_document_supported, true);
  assert.equal(
    (await (await f.request("/.well-known/oauth-protected-resource/mcp")).json())
      .resource,
    resource,
  );
  for (const uri of [
    "http://evil.example/callback",
    "https://user:password@evil.example/cb",
    "https://evil.example/cb#fragment",
    "file:///tmp/cb",
    "http://127.0.0.2:4000/cb",
  ]) {
    assert.equal(
      (
        await f.request("/register", {
          redirect_uris: [uri],
          token_endpoint_auth_method: "none",
        })
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await f.request("/register", {
        redirect_uris: [redirect],
        token_endpoint_auth_method: "client_secret_post",
      })
    ).status,
    400,
  );
  const client = await f.register();
  const wrongPort = await f.authorize(client, {
    redirect_uri: "http://127.0.0.1:49153/callback",
  });
  assert.equal(wrongPort.status, 400);
  assert.equal(wrongPort.headers.get("location"), null);
  assert.ok(
    !(await f.authorize(client, { code_challenge_method: "plain" })).headers
      .get("location")
      .includes("/settings/mcp"),
  );
  assert.ok(
    !(await f.authorize(client, { resource: "https://other.example/mcp" })).headers
      .get("location")
      .includes("/settings/mcp"),
  );
});

test("OAuth expiry applies to pending consent, access and refresh tokens", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const pending = await f.authorize(client);
  const id = new URL(pending.headers.get("location")).searchParams.get("authorization");
  f.advance(11 * 60_000);
  assert.equal(
    (await f.request(`/api/mcp-access/authorizations/${id}`, undefined, true)).status,
    410,
  );
  const tokens = await (await f.exchange(client, await f.code(client))).json();
  f.advance(61 * 60_000);
  await assert.rejects(f.access().verifyAccessToken(tokens.access_token));
  const refreshed = await f.form("/token", {
    client_id: client.client_id,
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    resource,
  });
  assert.equal(refreshed.status, 200);
  const rotated = await refreshed.json();
  f.advance(31 * 24 * 60 * 60_000);
  assert.equal(
    (
      await f.form("/token", {
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: rotated.refresh_token,
        resource,
      })
    ).status,
    400,
  );
  await assert.rejects(f.access().verifyAccessToken(rotated.access_token));
});

test("OAuth revocation and authorization codes remain isolated between clients", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const other = await f.register({ client_name: "Other CLI" });
  const authCode = await f.code(client);
  assert.equal((await f.exchange(other, authCode)).status, 400);
  const tokens = await (await f.exchange(client, authCode)).json();
  assert.equal(
    (await f.form("/revoke", { client_id: other.client_id, token: tokens.access_token }))
      .status,
    200,
  );
  await f.access().verifyAccessToken(tokens.access_token);
  assert.equal(
    (
      await f.form("/token", {
        client_id: other.client_id,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        resource,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.form("/revoke", {
        client_id: client.client_id,
        token: tokens.refresh_token,
      })
    ).status,
    200,
  );
  await assert.rejects(f.access().verifyAccessToken(tokens.access_token));
});

test("OAuth registration is rate limited and does not expose fetched client metadata", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 20; i++) await f.register();
  const limited = await f.request("/register", {
    redirect_uris: [redirect],
    token_endpoint_auth_method: "none",
  });
  assert.equal(limited.status, 429);
  const arbitrary = await f.request(
    "/authorize?" +
      new URLSearchParams({
        client_id: "https://attacker.example/client.json",
        redirect_uri: redirect,
      }),
  );
  assert.equal(arbitrary.status, 400);
});

test("OAuth is unavailable without a configured origin and rejects nonloopback HTTP", async (t) => {
  const f = await fixture(t, { publicUrl: null });
  const status = await (await f.request("/api/mcp-access", undefined, true)).json();
  assert.equal(status.available, false);
  assert.equal(status.mcpUrl, null);
  assert.equal((await f.request("/.well-known/oauth-authorization-server")).status, 404);
  assert.throws(
    () => createMcpAccess({ directory: f.directory, publicUrl: "http://agent.example" }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      createMcpAccess({
        directory: f.directory,
        publicUrl: "https://user:password@agent.example",
      }),
    /HTTPS/,
  );
});

test("Official MCP SDK discovers public registration and completes PKCE authorization and refresh", async (t) => {
  const f = await fixture(t);
  let clientInformation;
  let tokens;
  let codeVerifier;
  let authorizationUrl;
  const provider = {
    redirectUrl: redirect,
    clientMetadata: {
      client_name: "SDK CLI",
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    clientInformation: () => clientInformation,
    saveClientInformation: (value) => {
      clientInformation = value;
    },
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value;
    },
    redirectToAuthorization: (value) => {
      authorizationUrl = value;
    },
    saveCodeVerifier: (value) => {
      codeVerifier = value;
    },
    codeVerifier: () => codeVerifier,
    state: () => "sdk-state",
  };
  const options = {
    serverUrl: resource,
    scope: "catalog:read runs:read",
    fetchFn: f.fetchFn,
  };
  assert.equal(await auth(provider, options), "REDIRECT");
  assert.ok(codeVerifier);
  const consentResponse = await f.request(
    authorizationUrl.pathname + authorizationUrl.search,
  );
  const id = new URL(consentResponse.headers.get("location")).searchParams.get(
    "authorization",
  );
  const approved = await f.request(
    `/api/mcp-access/authorizations/${id}/approve`,
    selection,
    true,
  );
  const callback = new URL((await approved.json()).redirectUrl);
  assert.equal(callback.searchParams.get("state"), "sdk-state");
  assert.equal(
    await auth(provider, {
      ...options,
      authorizationCode: callback.searchParams.get("code"),
    }),
    "AUTHORIZED",
  );
  assert.deepEqual(
    (await f.access().verifyAccessToken(tokens.access_token)).extra.grant.projectIds,
    ["p1"],
  );
  const previous = tokens.refresh_token;
  assert.equal(await auth(provider, options), "AUTHORIZED");
  assert.notEqual(tokens.refresh_token, previous);
});

test("OAuth requires explicit resource at authorization, exchange and refresh", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const withoutResource = await f.request(
    "/authorize?" +
      new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirect,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
  );
  assert.equal(
    new URL(withoutResource.headers.get("location")).searchParams.get("error"),
    "invalid_request",
  );
  const authCode = await f.code(client);
  const missing = await f.form("/token", {
    client_id: client.client_id,
    grant_type: "authorization_code",
    code: authCode,
    code_verifier: verifier,
    redirect_uri: redirect,
  });
  assert.equal(missing.status, 400);
  const tokens = await (await f.exchange(client, authCode)).json();
  const refresh = await f.form("/token", {
    client_id: client.client_id,
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  });
  assert.equal(refresh.status, 400);
  await assert.rejects(f.access().verifyAccessToken("invalid"));
});

test("OAuth exchange fails closed on SQLite errors without consuming the authorization code", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const code = await f.code(client);
  const db = new DatabaseSync(path.join(f.directory, "access.sqlite"));
  t.after(() => db.close());
  db.exec(`CREATE TRIGGER fail_tokens BEFORE INSERT ON records
    WHEN NEW.kind = 'access' BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END;`);
  const failed = await f.exchange(client, code);
  assert.equal(failed.status, 500);
  const failure = await failed.json();
  assert.equal(failure.error, "server_error");
  assert.ok(!JSON.stringify(failure).includes("synthetic"));
  assert.equal(
    db
      .prepare("SELECT count(*) AS count FROM records WHERE kind IN ('access','refresh')")
      .get().count,
    0,
  );
  db.exec("DROP TRIGGER fail_tokens");
  const retried = await f.exchange(client, code);
  assert.equal(retried.status, 200);
  await f.access().verifyAccessToken((await retried.json()).access_token);
});
