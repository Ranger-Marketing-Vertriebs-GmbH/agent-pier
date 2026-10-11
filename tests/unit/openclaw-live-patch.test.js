import test from "node:test";
import assert from "node:assert/strict";
import { patchConfig } from "../../server/features/assistants/openclaw-config/live-patch.js";

function client(responses) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push([method, params]);
      const next = responses[method];
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(params) : next;
    },
  };
}

test("a patch carries the base hash and replace paths", async () => {
  const gateway = client({
    "config.get": { hash: "h1", config: { cron: { enabled: false } } },
    "config.patch": { ok: true },
  });
  await patchConfig(gateway, (current) =>
    current.cron.enabled
      ? null
      : { patch: { cron: { enabled: true } }, replacePaths: ["cron"] },
  );
  assert.deepEqual(gateway.calls[1], [
    "config.patch",
    {
      baseHash: "h1",
      raw: JSON.stringify({ cron: { enabled: true } }),
      replacePaths: ["cron"],
    },
  ]);
});

test("an unchanged value sends no patch", async () => {
  const gateway = client({
    "config.get": { hash: "h1", config: { cron: { enabled: true } } },
  });
  const result = await patchConfig(gateway, (c) =>
    c.cron.enabled ? null : { patch: {} },
  );
  assert.equal(result, null);
  assert.equal(gateway.calls.length, 1);
});

test("a stale base hash becomes a conflict", async () => {
  const stale = Object.assign(Error("stale"), { code: "CONFLICT", answered: true });
  const gateway = client({
    "config.get": { hash: "h1", config: {} },
    "config.patch": stale,
  });
  await assert.rejects(
    patchConfig(gateway, () => ({ patch: { a: 1 } })),
    { status: 409 },
  );
});

test("other patch failures and a missing config pass through", async () => {
  const broken = Object.assign(Error("boom"), { code: "UNAVAILABLE", answered: true });
  const gateway = client({ "config.get": { hash: "h1" }, "config.patch": broken });
  await assert.rejects(
    patchConfig(gateway, (c) => ({ patch: { seen: c } })),
    broken,
  );
  assert.equal(gateway.calls[1][1].raw, JSON.stringify({ seen: {} }));
});
