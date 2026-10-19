import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, fixtureFetch } from "../helpers/application.js";

// A replacement spec of 64 KiB, JSON-escaped, exceeds the global body limit; the gate
// route takes it to validation, other run routes keep the global limit.
test("a full-size replacement spec reaches the gate instead of the body limit", async (t) => {
  const { url } = await applicationFixture(t);
  const spec = `## Acceptance criteria\n${'1. "quoted"\n'.repeat(5000)}`.slice(0, 65536);
  const post = (suffix) =>
    fixtureFetch(`${url}/api/pipeline-runs/missing-run/${suffix}`, {
      method: "POST",
      headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ action: "replace-spec", spec }),
    });
  const gate = await post("gate");
  assert.equal(gate.status, 404, await gate.clone().text());
  assert.equal((await post("cancel")).status, 413);
});
