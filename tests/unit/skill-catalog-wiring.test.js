import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  connectSkillCatalog,
  reportedSkillNames,
} from "../../server/application/skill-catalog-wiring.js";

const client = (answer) => ({
  ready: true,
  calls: [],
  async call(method, params) {
    this.calls.push([method, params]);
    if (answer instanceof Error) throw answer;
    return answer;
  },
});

test("reported names leave out the catalog's own source", async () => {
  const gateway = client({
    skills: [
      { name: "github", source: "openclaw-bundled" },
      { name: "probe", source: "openclaw-extra" },
      { name: "mine", source: "openclaw-workspace" },
    ],
  });
  const names = await reportedSkillNames({ client: gateway });
  assert.deepEqual([...names].sort(), ["github", "mine"]);
  assert.deepEqual(gateway.calls, [["skills.status", {}]]);
});

test("no ready Gateway, or one that fails, reports nothing", async () => {
  assert.equal(await reportedSkillNames({}), null);
  assert.equal(await reportedSkillNames({ client: { ready: false } }), null);
  assert.equal(await reportedSkillNames({ client: client(new Error("down")) }), null);
});

test("the catalog store reaches the services and every spawn verifies it first", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-catalog-wiring-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillCatalog = path.join(root, "skill-catalog");
  fs.mkdirSync(path.join(skillCatalog, "staging", "leftover"), { recursive: true });
  const order = [];
  const runtime = {
    paths: { root, skillCatalog },
    beforeSpawn: async () => order.push("previous"),
  };
  const assistants = { skills: {}, config: {} };
  const catalog = connectSkillCatalog({ assistantRuntime: runtime, assistants });
  t.after(() => catalog.close());
  const store = catalog.store;
  assert.equal(assistants.skills.catalog, store);
  assert.equal(assistants.config.skillCatalog, store);
  assert.equal(runtime.skillCatalog, store);
  assert.equal(fs.existsSync(path.join(skillCatalog, "staging", "leftover")), false);
  const verify = store.verify.bind(store);
  store.verify = (...args) => {
    order.push("verify");
    return verify(...args);
  };
  await runtime.beforeSpawn();
  assert.deepEqual(order, ["verify", "previous"]);
  store.verify = () => {
    throw new Error("EIO");
  };
  await assert.rejects(runtime.beforeSpawn(), /EIO/);
  assert.deepEqual(order, ["verify", "previous"]);
});
