import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LoginStore,
  localAttempts,
  networkAttemptLimit,
} from "../../server/features/login/login-store.js";
import { hashPassword, limited } from "../../server/features/login/passwords.js";
import { attemptSource } from "../../server/http/login.js";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-login-limits-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let time = Date.now();
  return {
    store: new LoginStore({ dataDir, now: () => time }),
    advance: (duration) => {
      time += duration;
    },
  };
}
const network = (remoteAddress) =>
  attemptSource({ trustBranch: "network", headers: {}, socket: { remoteAddress } });
const refused = (store, source) =>
  assert.throws(() => store.throttle(source), { status: 429 });

test("changing the network address never gets past the shared network limit", (t) => {
  const f = fixture(t);
  for (let index = 0; index < networkAttemptLimit; index++)
    f.store.throttle(network(`10.0.${index >> 8}.${index & 255}`));
  refused(f.store, network("10.9.9.9"));
  // A refused attempt creates no window of its own.
  assert.equal(f.store.attempts.windows.has("network:10.9.9.9"), false);
  // The computer itself keeps its own way in.
  f.store.throttle(attemptSource({ trustBranch: "local", headers: {} }));
  f.advance(60000);
  f.store.throttle(network("10.9.9.9"));
});

test("one network address still has ten attempts and uses up no more of the shared ones", (t) => {
  const f = fixture(t);
  for (let index = 0; index < 10; index++) f.store.throttle(network("10.0.0.7"));
  for (let index = 0; index < 50; index++) refused(f.store, network("10.0.0.7"));
  assert.equal(f.store.attempts.windows.get("network").count, 10);
  f.store.throttle(network("10.0.0.8"));
});

test("expired windows leave the map without waiting for it to fill", (t) => {
  const f = fixture(t);
  f.store.throttle(localAttempts);
  for (let index = 0; index < 40; index++) f.store.throttle(network(`10.0.0.${index}`));
  assert.equal(f.store.attempts.windows.size, 42);
  f.advance(60000);
  f.store.throttle(network("10.0.1.1"));
  assert.deepEqual([...f.store.attempts.windows.keys()].sort(), [
    "network",
    "network:10.0.1.1",
  ]);
});

test("at most two password hashes run at once and the rest wait their turn", async () => {
  let running = 0;
  let most = 0;
  const releases = [];
  const run = limited(async (value) => {
    most = Math.max(most, ++running);
    await new Promise((resolve) => releases.push(resolve));
    running--;
    if (value === "fails") throw new Error("failed");
    return value;
  }, 2);
  const results = ["a", "fails", "c", "d", "e"].map((value) =>
    run(value).catch((error) => error.message),
  );
  for (let done = 0; done < 5; done++) {
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(releases.length <= 2);
    releases.shift()();
  }
  assert.deepEqual(await Promise.all(results), ["a", "failed", "c", "d", "e"]);
  assert.equal(most, 2);
  assert.equal(running, 0);
  // The real hash still answers, also when more than two are asked for at once.
  const hashes = await Promise.all(
    [1, 2, 3].map(() => hashPassword("disposable-unit-password", "a".repeat(64))),
  );
  assert.equal(new Set(hashes.map((hash) => hash.toString("hex"))).size, 1);
});
