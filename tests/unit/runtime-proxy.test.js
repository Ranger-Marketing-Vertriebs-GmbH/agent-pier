import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeProxy } from "../../server/features/model-logins/runtime-proxy.js";
import { chatgptRoute } from "../../server/features/model-logins/chatgpt-proxy.js";
import { ChatGptAuth } from "../../server/features/model-logins/chatgpt-auth.js";
import { ChatGptVault } from "../../server/features/model-logins/chatgpt-vault.js";
import {
  fakeAccess,
  startFakeChatgptOAuth,
  startFakeCodex,
} from "../helpers/fake-chatgpt.js";

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-proxy-"));
  const issuer = await startFakeChatgptOAuth();
  const codex = await startFakeCodex();
  const vault = new ChatGptVault({
    dataDir,
    auth: new ChatGptAuth({ issuer: issuer.url }),
    schedule: false,
    warn: () => {},
  });
  const pair = issuer.issue();
  const profileId = vault.save({
    access: pair.access_token,
    refresh: pair.refresh_token,
    expires: Date.now() + 3600_000,
    accountId: "acct-fixture",
    email: "owner@example.invalid",
    residency: "eu",
  });
  const proxy = new RuntimeProxy({ dataDir, warn: () => {} });
  const allowed = new Set(["agent-a"]);
  proxy.route(
    "chatgpt",
    chatgptRoute({
      vault,
      upstream: codex.url,
      authorize: (agentId) => allowed.has(agentId),
      warn: () => {},
    }),
  );
  const url = await proxy.start();
  t.after(async () => {
    await proxy.close();
    vault.close();
    await codex.close();
    await issuer.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const credential = proxy.credential(["chatgpt", "agent-a", profileId]);
  const call = (pathname, { token = credential, method = "POST", body, headers } = {}) =>
    fetch(`${url}${pathname}`, {
      method,
      headers: {
        ...(token && { authorization: `Bearer ${token}` }),
        "content-type": "application/json",
        ...headers,
      },
      ...(method === "POST" && { body: JSON.stringify(body ?? { input: [] }) }),
    });
  return {
    dataDir,
    issuer,
    codex,
    vault,
    proxy,
    url,
    credential,
    call,
    profileId,
    allowed,
  };
}

const userTurn = (text) => ({
  model: "gpt-5.4",
  stream: true,
  input: [{ role: "user", content: [{ type: "input_text", text }] }],
});

test("the proxy swaps its credential for the account's token and streams SSE through", async (t) => {
  const { call, codex, vault, profileId, credential } = await fixture(t);
  const response = await call("/chatgpt/codex/responses", {
    body: userTurn("hello"),
    headers: {
      "chatgpt-account-id": "spoofed",
      originator: "codex_cli_rs",
      "accept-encoding": "zstd",
    },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /CODEX: hello/);
  const [request] = codex.requests;
  assert.equal(request.url, "/backend-api/codex/responses");
  assert.equal(
    request.headers.authorization,
    `Bearer ${vault.accessOf(profileId).access}`,
  );
  assert.equal(request.headers["chatgpt-account-id"], "acct-fixture");
  assert.equal(request.headers["x-openai-internal-codex-residency"], "eu");
  assert.equal(request.headers.originator, "codex_cli_rs");
  assert.notEqual(request.headers["accept-encoding"], "zstd");
  assert.ok(!JSON.stringify(request.headers).includes(credential));
  // The model catalog passes its query through.
  const models = await call("/chatgpt/codex/models?client_version=0.160.0", {
    method: "GET",
  });
  assert.equal(models.status, 200);
  assert.equal((await models.json()).models[0].slug, "gpt-5.4");
  assert.equal(codex.requests[1].url, "/backend-api/codex/models?client_version=0.160.0");
});

test("a 401 from the backend renews the token once and replays the request", async (t) => {
  const { call, codex, vault, profileId, issuer } = await fixture(t);
  const old = vault.accessOf(profileId).access;
  codex.reject.add(old);
  const response = await call("/chatgpt/codex/responses", { body: userTurn("again") });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /CODEX: again/);
  assert.equal(issuer.state.refreshes, 1);
  assert.equal(codex.requests.length, 2);
  assert.notEqual(codex.requests[1].headers.authorization, `Bearer ${old}`);
  assert.deepEqual(codex.requests[1].body, codex.requests[0].body);
  // Still rejected after the renewal: the 401 reaches the runtime, without the
  // backend's WWW-Authenticate.
  codex.reject.add(vault.accessOf(profileId).access);
  codex.reject.add(fakeAccess());
  const second = await call("/chatgpt/codex/responses", { body: userTurn("x") });
  assert.equal(second.headers.get("www-authenticate"), null);
});

test("credentials, scopes, browsers and signed-out logins are refused", async (t) => {
  const { call, proxy, profileId, codex, allowed, vault } = await fixture(t);
  assert.equal((await call("/chatgpt/codex/responses", { token: "nope" })).status, 401);
  assert.equal((await call("/chatgpt/codex/responses", { token: null })).status, 401);
  const forged = proxy.credential(["chatgpt", "agent-a", profileId]).slice(0, -2) + "AA";
  assert.equal((await call("/chatgpt/codex/responses", { token: forged })).status, 401);
  const mcp = proxy.credential(["mcp", "server"]);
  assert.equal((await call("/chatgpt/codex/responses", { token: mcp })).status, 401);
  assert.equal(
    (await call("/chatgpt/codex/responses", { headers: { origin: "https://evil" } }))
      .status,
    403,
  );
  assert.equal((await call("/chatgpt/other")).status, 404);
  allowed.delete("agent-a");
  assert.equal((await call("/chatgpt/codex/responses")).status, 403);
  allowed.add("agent-a");
  vault.remove(profileId);
  const gone = await call("/chatgpt/codex/responses");
  assert.equal(gone.status, 401);
  assert.equal((await gone.json()).error.code, "agentpier_login_required");
  assert.equal(codex.requests.length, 0);
  // A rotated key revokes every credential handed out before.
  const before = proxy.credential(["chatgpt", "agent-a", profileId]);
  proxy.rotate();
  assert.equal(proxy.verify(`Bearer ${before}`), null);
});

test("the proxy keeps its port and key across restarts and listens on loopback only", async (t) => {
  const { proxy, url, dataDir } = await fixture(t);
  const file = path.join(dataDir, "model-logins", "proxy.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(proxy.server.address().address, "127.0.0.1");
  const credential = proxy.credential(["chatgpt", "a", "b"]);
  await proxy.close();
  const again = new RuntimeProxy({ dataDir });
  t.after(() => again.close());
  assert.equal(await again.start(), url);
  assert.deepEqual(again.verify(`Bearer ${credential}`), ["chatgpt", "a", "b"]);
  // A slow stream is not cut off by a request timeout.
  assert.equal(again.server.requestTimeout, 0);
  assert.equal(again.server.headersTimeout, 30_000);
});
