import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";
import { toolSchemas } from "../../server/features/mcp/tool-schemas.js";
import { DEFAULT_RISK } from "../../server/features/pipelines/risk-rules.js";

test("project risk rules are the owner's HTTP setting with defaults, audited and kept", async (t) => {
  const app = await applicationFixture(t);
  const scope = await (
    await app.request("/api/memory/projects", {
      method: "POST",
      body: { cwd: app.project },
    })
  ).json();
  const url = `/api/pipeline-risk/${scope.id}`;
  const initial = await (await app.request(url)).json();
  assert.equal(initial.custom, false);
  assert.deepEqual(initial.globs, DEFAULT_RISK.globs);
  assert.equal(initial.newDependency, true);
  const saved = await app.request(url, {
    method: "PUT",
    body: { globs: ["infra/**", " /.github/** "], newDependency: false },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).globs, ["infra/**", "/.github/**"]);
  assert.equal(
    (
      await app.request(url, {
        method: "PUT",
        body: { globs: ["../x"], newDependency: true },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await app.request("/api/pipeline-risk/missing", {
        method: "PUT",
        body: { globs: [], newDependency: true },
      })
    ).status,
    404,
  );
  // Turning the gate off is saved and audited like any other rule change.
  const off = await app.request(url, {
    method: "PUT",
    body: { globs: ["infra/**", "/.github/**"], newDependency: false, enabled: false },
  });
  assert.equal((await off.json()).enabled, false);
  const events = (await (await app.request("/api/audit?action=pipeline.updated")).json())
    .events;
  const rules = events.filter((event) => event.details?.kind === "risk-rules");
  assert.deepEqual(
    rules.map((event) => event.details),
    [
      { kind: "risk-rules", enabled: false, count: 2 },
      { kind: "risk-rules", enabled: true, count: 2 },
    ],
  );
  assert.equal(rules[0].projectId, scope.id);
  await app.restart();
  const kept = await (await app.request(url)).json();
  assert.equal(kept.custom, true);
  assert.deepEqual(kept.globs, ["infra/**", "/.github/**"]);
  assert.equal(kept.newDependency, false);
  assert.equal(kept.enabled, false);
});

test("no agent-reachable MCP tool reads or writes project risk rules", () => {
  for (const [name, schema] of Object.entries(toolSchemas))
    assert.ok(
      !/risk|verification_save|verification_set/.test(name) &&
        !JSON.stringify(schema).includes("risk"),
      name,
    );
});
