import test from "node:test";
import assert from "node:assert/strict";
import {
  HookHostRefusals,
  hookHostLabel,
} from "../../server/features/assistants/agent-hook-host-refusals.js";

const hookA = "3f1c2a9e-0000-4000-8000-000000000001";
const hookB = "3f1c2a9e-0000-4000-8000-000000000002";
const hour = 3_600_000;

function clock(start = Date.parse("2026-10-26T10:00:00Z")) {
  let at = start;
  const now = () => at;
  now.advance = (ms) => (at += ms);
  return now;
}

test("a host label keeps a plain host name, IP or bracketed IPv6 with port only", () => {
  assert.equal(
    hookHostLabel("Mac-Studio.tail2788d4.ts.net"),
    "mac-studio.tail2788d4.ts.net",
  );
  assert.equal(hookHostLabel("192.168.1.20:4380"), "192.168.1.20:4380");
  assert.equal(hookHostLabel("[fd7a:115c::1]:443"), "[fd7a:115c::1]:443");
  for (const value of [
    undefined,
    "",
    "a b",
    "host/path",
    "user@host",
    "host:99999999",
    "x".repeat(254),
    "evil host",
    42,
  ])
    assert.equal(hookHostLabel(value), null, String(value));
});

test("refusals are counted per hook and host and audited once an hour", () => {
  const now = clock();
  const refusals = new HookHostRefusals({ now });
  assert.deepEqual(refusals.record(hookA, "mac-studio.ts.net"), { audit: true });
  now.advance(1000);
  assert.deepEqual(refusals.record(hookA, "MAC-STUDIO.ts.net"), { audit: false });
  assert.deepEqual(refusals.latest(hookA), {
    host: "mac-studio.ts.net",
    count: 2,
    at: new Date(now()).toISOString(),
  });
  now.advance(hour);
  assert.deepEqual(refusals.record(hookA, "mac-studio.ts.net"), { audit: true });
  assert.equal(refusals.latest(hookB), null);
  // A host that is no host is neither recorded nor audited.
  assert.equal(refusals.record(hookA, "a b"), null);
  assert.equal(refusals.latest(hookA).count, 3);
});

test("each hook keeps its few latest hosts, and entries expire after a day", () => {
  const now = clock();
  const refusals = new HookHostRefusals({ now, perHook: 2 });
  refusals.record(hookA, "one.example");
  now.advance(10);
  refusals.record(hookA, "two.example");
  now.advance(10);
  refusals.record(hookA, "three.example");
  now.advance(10);
  refusals.record(hookB, "two.example");
  assert.deepEqual(
    refusals.recent().map(({ host, count }) => [host, count]),
    [
      ["two.example", 2],
      ["three.example", 1],
    ],
  );
  assert.equal(refusals.latest(hookA).host, "three.example");
  now.advance(24 * hour);
  assert.equal(refusals.latest(hookA), null);
  assert.deepEqual(refusals.recent(), []);
});

test("the overview lists at most ten hosts, newest first, and forgets deleted hooks", () => {
  const now = clock();
  const refusals = new HookHostRefusals({ now, perHook: 20 });
  for (let i = 0; i < 12; i += 1) {
    now.advance(10);
    refusals.record(hookA, `h${i}.example`);
  }
  const listed = refusals.recent();
  assert.equal(listed.length, 10);
  assert.equal(listed[0].host, "h11.example");
  refusals.forget(hookA);
  assert.deepEqual(refusals.recent(), []);
});
