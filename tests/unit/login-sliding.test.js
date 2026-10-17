import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import {
  LoginStore,
  absoluteDuration,
  idleDuration,
} from "../../server/features/login/login-store.js";
import { requireLogin } from "../../server/http/login.js";
const day = 24 * 60 * 60 * 1000;
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-login-sliding-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let time = Date.UTC(2026, 0, 1);
  const options = { dataDir, now: () => time };
  const f = {
    options,
    store: new LoginStore(options),
    advance: (duration) => {
      time += duration;
    },
    now: () => time,
    stored: () => JSON.parse(fs.readFileSync(f.store.file, "utf8")),
  };
  return f;
}
// Hashing is not under test: install a user directly so each test issues sessions cheaply.
function configured(f) {
  f.store.data.user = {
    username: "fixture",
    salt: "a".repeat(64),
    hash: "b".repeat(128),
  };
  f.store.save();
}
test("a session renews once past half its idle window and never writes when not due", (t) => {
  const f = fixture(t);
  configured(f);
  const token = f.store.issue();
  const session = f.store.require(token);
  assert.equal(session.expires, f.now() + idleDuration);
  assert.equal(session.created, f.now());
  f.advance(idleDuration / 2 - 1000);
  const before = fs.statSync(f.store.file).mtimeMs;
  const written = f.stored();
  assert.equal(f.store.renew(f.store.require(token)), null);
  assert.deepEqual(f.stored(), written);
  assert.equal(fs.statSync(f.store.file).mtimeMs, before);
  f.advance(2000);
  assert.equal(f.store.renew(f.store.require(token)), idleDuration);
  assert.equal(f.stored().sessions[0].expires, f.now() + idleDuration);
  assert.equal(f.stored().sessions[0].lastUsed, f.now());
  assert.ok(new LoginStore(f.options).session(token));
});
test("an idle session expires after the idle window", (t) => {
  const f = fixture(t);
  configured(f);
  const token = f.store.issue();
  f.advance(idleDuration - 1);
  assert.ok(f.store.session(token));
  f.advance(1);
  assert.equal(f.store.session(token), null);
  assert.equal(new LoginStore(f.options).session(token), null);
});
test("renewal never extends a session beyond the absolute cap from creation", (t) => {
  const f = fixture(t);
  configured(f);
  const token = f.store.issue();
  const created = f.now();
  // Daily use for eighty days: renewals reach the cap, which then no longer moves.
  for (let elapsed = 0; elapsed < 80 * day; elapsed += 10 * day) {
    f.advance(10 * day);
    f.store.renew(f.store.require(token));
  }
  assert.equal(f.store.require(token).expires, created + absoluteDuration);
  const written = f.stored();
  f.advance(day / 2);
  assert.equal(f.store.renew(f.store.require(token)), null);
  assert.equal(f.stored().sessions[0].expires, written.sessions[0].expires);
  f.advance(created + absoluteDuration - f.now());
  assert.equal(f.store.session(token), null);
});
test("the session limit evicts the least recently used session, also after restart", (t) => {
  const f = fixture(t);
  configured(f);
  const tokens = [];
  for (let i = 0; i < 20; i++) {
    tokens.push(f.store.issue());
    f.advance(1000);
  }
  // The oldest session stays in use; the second-oldest becomes least recently used.
  f.advance(idleDuration / 2);
  f.store.renew(f.store.require(tokens[0]));
  for (const token of tokens.slice(2)) f.store.renew(f.store.require(token));
  const restarted = new LoginStore(f.options);
  let closed = 0;
  const cleanup = restarted.watch(restarted.session(tokens[1]), () => closed++);
  t.after(cleanup);
  restarted.issue();
  assert.ok(restarted.session(tokens[0]));
  assert.equal(restarted.session(tokens[1]), null);
  assert.equal(closed, 1);
  assert.equal(restarted.data.sessions.length, 20);
});
test("watchers follow a renewed expiry instead of closing at the old one", (t) => {
  const f = fixture(t);
  configured(f);
  const token = f.store.issue();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let closed = 0;
  const cleanup = f.store.watch(f.store.require(token), () => closed++);
  t.after(cleanup);
  f.advance(idleDuration / 2 + day);
  t.mock.timers.tick(idleDuration / 2 + day);
  f.store.renew(f.store.require(token));
  f.advance(idleDuration / 2);
  t.mock.timers.tick(idleDuration / 2);
  assert.equal(closed, 0);
  f.advance(idleDuration / 2);
  t.mock.timers.tick(idleDuration / 2);
  assert.equal(closed, 1);
  assert.equal(f.store.session(token), null);
});
test("legacy sessions without timestamps migrate from their seven-day expiry", (t) => {
  const f = fixture(t);
  configured(f);
  const token = f.store.issue();
  const legacy = f.stored();
  const expires = f.now() + 3 * day;
  legacy.sessions = [{ hash: legacy.sessions[0].hash, expires }];
  fs.writeFileSync(f.store.file, JSON.stringify(legacy));
  const store = new LoginStore(f.options);
  assert.equal(store.session(token).created, expires - 7 * day);
  assert.equal(store.session(token).lastUsed, expires - 7 * day);
  const session = store.require(token);
  assert.equal(session.lastUsed, f.now());
  assert.equal(store.renew(session), idleDuration);
  assert.equal(store.data.sessions[0].expires, f.now() + idleDuration);
});
test("a normal authenticated request reissues the cookie with the renewed Max-Age", async (t) => {
  const f = fixture(t);
  configured(f);
  const token = f.store.issue();
  const app = express();
  app.use(requireLogin(f.store, () => ({ port: 0 })));
  app.get("/state", (_req, res) => res.json({ ok: true }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).end());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/state`;
  const headers = { cookie: `agentpier_session=${token}` };
  const fresh = await fetch(url, { headers });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers.get("set-cookie"), null);
  f.advance(idleDuration / 2 + day);
  const renewed = await fetch(url, { headers });
  assert.equal(renewed.status, 200);
  const cookie = renewed.headers.get("set-cookie");
  assert.match(cookie, new RegExp(`^agentpier_session=${token};`));
  assert.match(cookie, new RegExp(`Max-Age=${idleDuration / 1000}`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
});
