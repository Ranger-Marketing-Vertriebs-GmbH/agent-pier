import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HermesRoutineMeta } from "../../server/features/assistants/runtimes/hermes/hermes-routine-meta.js";
import {
  fakeHermesSupervisor,
  hermesTestRuntime,
} from "../helpers/hermes-fake-gateway.js";

// Since Hermes v0.23 the cron REST routes refuse to update AgentPier's `agentpier`
// field, so AgentPier keeps its part of each routine itself (hermes-routine-meta.js);
// a job written for v0.22.5 still carries its field until AgentPier writes its own.

const routine = (extra = {}) => ({
  name: "Daily",
  marker: "agentpier-reminder:d",
  agentId: "ap-1",
  enabled: true,
  keepAfterRun: true,
  schedule: { kind: "cron", expression: "0 9 * * *" },
  wakeNow: true,
  alertOnFailure: false,
  target: { kind: "own" },
  prompt: { text: "Hi", timeoutSeconds: 60, fullContext: true, tools: [] },
  delivery: { kind: "none" },
  ...extra,
});

test("the meta lives in its own file, a v0.22.5 job's field counts until then", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-routine-meta-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "agentpier-routines.json");
  const meta = new HermesRoutineMeta(file);
  const old = { id: "j1", agentpier: { marker: "old", revision: 3 } };
  assert.deepEqual(meta.attach(old), old);
  meta.set("j1", { marker: "new", revision: 4 });
  assert.equal(meta.attach(old).agentpier.marker, "new");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    j1: { marker: "new", revision: 4 },
  });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  meta.set("j2", { marker: "two" });
  meta.prune(["j1", "j9"]);
  assert.deepEqual(meta.ids(), ["j2"]);
  meta.delete("j2");
  assert.deepEqual(meta.ids(), []);
  assert.deepEqual(meta.attach({ id: "j3" }), { id: "j3" });
});

test("routines keep their meta although Hermes refuses the field, and old jobs update", async () => {
  const supervisor = fakeHermesSupervisor({ agentId: "ap-1" });
  const { routines } = hermesTestRuntime(supervisor);
  await supervisor.start();
  const added = await routines.add({ routine: routine() });
  assert.equal(added.marker, "agentpier-reminder:d");
  const job = supervisor.store.cron.jobs.get(added.id);
  assert.equal("agentpier" in job, false);
  const changed = await routines.update({ id: added.id, patch: { name: "Renamed" } });
  assert.equal(changed.name, "Renamed");
  assert.equal(changed.marker, "agentpier-reminder:d");
  assert.equal(changed.revision, 2);
  // A job AgentPier wrote for Hermes v0.22.5 keeps its meta in the job itself.
  supervisor.store.cron.jobs.set("old1", {
    ...job,
    id: "old1",
    name: "Old",
    agentpier: { ...(await routines.list())[0], marker: "agentpier-reminder:o" },
  });
  const listed = await routines.list();
  assert.ok(listed.some((r) => r.id === "old1" && r.marker === "agentpier-reminder:o"));
  const updated = await routines.update({ id: "old1", patch: { enabled: false } });
  assert.equal(updated.marker, "agentpier-reminder:o");
  assert.equal(updated.enabled, false);
});
