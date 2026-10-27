import { test, mock } from "node:test";
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

const skillPack = (name) => ({
  name,
  description: "Fixture.",
  files: [
    ["SKILL.md", Buffer.from(`---\nname: ${name}\ndescription: Fixture.\n---\nHi\n`)],
  ],
});
const meta = { importKind: "skill-md", scan: { verdict: "ok", rules: [] } };

function wired(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-catalog-wiring-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillCatalog = path.join(root, "skill-catalog");
  fs.mkdirSync(path.join(skillCatalog, "staging", "leftover"), { recursive: true });
  const order = [];
  const runtime = {
    paths: { root, skillCatalog },
    teamConfiguration: async (installed) => {
      order.push("compile");
      return { installed };
    },
  };
  const assistants = { skills: {}, config: {} };
  const catalog = connectSkillCatalog({ assistantRuntime: runtime, assistants });
  t.after(() => catalog.close());
  return {
    root,
    skillCatalog,
    order,
    runtime,
    assistants,
    catalog,
    store: catalog.store,
  };
}

test("the catalog store reaches the services and every start verifies before its compile", async (t) => {
  const { skillCatalog, order, runtime, assistants, store } = wired(t);
  assert.equal(assistants.skills.catalog, store);
  assert.equal(assistants.config.skillCatalog, store);
  assert.equal(runtime.skillCatalog, store);
  assert.equal(fs.existsSync(path.join(skillCatalog, "staging", "leftover")), false);
  const verify = store.verify.bind(store);
  store.verify = (...args) => {
    order.push("verify");
    return verify(...args);
  };
  assert.deepEqual(await runtime.teamConfiguration("runtime"), { installed: "runtime" });
  assert.deepEqual(order, ["verify", "compile"]);
});

test("a catalog skill that cannot be checked never stops the start and is dropped", async (t) => {
  const { order, runtime, store } = wired(t);
  store.write(skillPack("probe"), meta);
  const live = path.join(store.liveRoot, "probe", "SKILL.md");
  fs.chmodSync(live, 0o600);
  fs.writeFileSync(live, "tampered");
  const errors = mock.method(console, "error", () => {});
  const rename = fs.renameSync;
  mock.method(fs, "renameSync", (from, to) => {
    if (String(to).endsWith(".json")) return rename(from, to);
    throw Object.assign(new Error("EIO /private/path"), { code: "EIO" });
  });
  try {
    assert.deepEqual(await runtime.teamConfiguration("runtime"), {
      installed: "runtime",
    });
  } finally {
    mock.restoreAll();
  }
  assert.deepEqual(order, ["compile"]);
  assert.deepEqual(store.dropped(["probe"]), ["probe"]);
  assert.equal(fs.existsSync(live), false);
  assert.ok(
    !errors.mock.calls.some((call) => String(call.arguments).includes("/private")),
  );
  // A whole-store failure is logged by its code and the start still compiles.
  store.verify = () => {
    throw Object.assign(new Error("EACCES /private/path"), { code: "EACCES" });
  };
  const logged = mock.method(console, "error", () => {});
  await runtime.teamConfiguration("runtime");
  mock.restoreAll();
  assert.deepEqual(order, ["compile", "compile"]);
  assert.match(String(logged.mock.calls[0].arguments[0]), /EACCES/);
  assert.doesNotMatch(String(logged.mock.calls[0].arguments[0]), /private/);
});
