import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { LoginStore, idleDuration } from "../../server/features/login/login-store.js";
import { requireLogin, sessionToken, sessionTokens } from "../../server/http/login.js";

const day = 24 * 60 * 60 * 1000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// A preview on another port of the same host receives (and may set) the session cookie,
// since cookies ignore ports; a planted second value must never sign the owner out.
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-login-cookies-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let time = Date.UTC(2026, 0, 1);
  const store = new LoginStore({ dataDir, now: () => time });
  // Hashing is not under test: install the owner directly.
  store.data.user = { username: "fixture", salt: "a".repeat(64), hash: "b".repeat(128) };
  store.save();
  return {
    store,
    advance: (duration) => {
      time += duration;
    },
  };
}

test("sessionToken picks the valid one of several agentpier_session cookies", (t) => {
  const { store } = fixture(t);
  const valid = store.issue();
  const forged = "c".repeat(64);
  for (const cookie of [
    `agentpier_session=planted; agentpier_session=${valid}`,
    `agentpier_session=${valid}; agentpier_session=planted`,
    `agentpier_session=${forged}; other=1; agentpier_session=${valid}`,
  ])
    assert.equal(sessionToken({ headers: { cookie } }, store), valid);
  assert.equal(
    sessionToken(
      { headers: { cookie: "agentpier_session=a; agentpier_session=b" } },
      store,
    ),
    "",
  );
  assert.equal(sessionToken({ headers: {} }, store), "");
  assert.deepEqual(
    sessionTokens({
      headers: { cookie: "x=1; agentpier_session=a; agentpier_session=b" },
    }),
    ["a", "b"],
  );
  assert.deepEqual(sessionTokens({ headers: {} }), []);
  assert.throws(() => sessionToken({ headers: {} }), TypeError);
});

test("requireLogin admits a request with a planted second cookie and renews only the valid token", async (t) => {
  const f = fixture(t);
  const valid = f.store.issue();
  const app = express();
  app.use(requireLogin(f.store, () => ({ port: 0 })));
  app.get("/state", (_req, res) => res.json({ ok: true }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).end());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/state`;
  const headers = { cookie: `agentpier_session=planted; agentpier_session=${valid}` };
  const fresh = await fetch(url, { headers });
  assert.equal(fresh.status, 200);
  f.advance(idleDuration / 2 + day);
  const renewed = await fetch(url, { headers });
  assert.equal(renewed.status, 200);
  assert.match(
    renewed.headers.get("set-cookie"),
    new RegExp(`^agentpier_session=${valid};`),
  );
  const refused = await fetch(url, {
    headers: { cookie: "agentpier_session=planted; agentpier_session=other" },
  });
  assert.equal(refused.status, 401);
});

test("every server call of sessionToken passes the login", () => {
  const files = fs
    .readdirSync(path.join(root, "server"), { recursive: true })
    .filter((file) => file.endsWith(".js"));
  const offenders = files.filter((file) =>
    /sessionToken\(req\)/.test(fs.readFileSync(path.join(root, "server", file), "utf8")),
  );
  assert.deepEqual(offenders, []);
});
