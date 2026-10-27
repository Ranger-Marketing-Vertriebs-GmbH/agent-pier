import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { compileOpenClawConfig } from "../../server/features/assistants/runtime-config.js";
import { connectSkillCatalog } from "../../server/application/skill-catalog-wiring.js";
import { readJSON } from "../../server/lib/storage.js";

// The Gateway start compile with the skill catalog wired in (skill-catalog-wiring.js):
// every start checks the catalog copies, then compiles each agent's list without the
// catalog names it must not load. A catalog that cannot be read never stops the start.
const agent = {
  id: "a-home",
  runtimeAgentId: "ap-home",
  capabilities: { memory: false, reminders: false },
  skills: ["github", "other", "probe"],
};
const teams = {
  directory: "/plugin",
  connection: { url: "http://127.0.0.1:1", token: "bridge" },
  hostMaxConcurrent: 4,
  native: { token: "hook" },
  profiles: [agent],
};
const skillPack = (name, marker = "v1") => ({
  name,
  description: "Fixture.",
  files: [
    [
      "SKILL.md",
      Buffer.from(`---\nname: ${name}\ndescription: Fixture.\n---\n${marker}\n`),
    ],
  ],
});
const meta = { importKind: "upload", scan: { verdict: "clean", rules: [] } };

function catalogStart(t) {
  const dataDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "catalog-start-")),
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  // The runtime package bundles "github" (bundledSkillNames reads its skills folder).
  const runtimeDir = path.join(dataDir, "rt");
  fs.mkdirSync(path.join(runtimeDir, "skills", "github"), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "skills", "github", "SKILL.md"), "---\n---\n");
  const spawned = [];
  const supervisor = new RuntimeSupervisor({
    dataDir,
    install: async () => ({
      nodePath: "/rt/node/bin/node",
      entryPath: path.join(runtimeDir, "e.mjs"),
    }),
    spawn: () => {
      spawned.push(true);
      return Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null,
        kill() {
          this.exitCode = 0;
          this.emit("exit", 0);
        },
      });
    },
    clientFactory: () =>
      Object.assign(new EventEmitter(), {
        ready: false,
        async connect() {
          this.ready = true;
        },
        close() {
          this.ready = false;
        },
      }),
    shellOwner: () => null,
  });
  t.after(() => supervisor.close());
  supervisor.teamConfiguration = async () => teams;
  const paths = runtimePaths(dataDir);
  const seeded = compileOpenClawConfig({ paths, port: 1, token: "t", teams: null });
  seeded.agents = { ...seeded.agents, entries: { "ap-home": { id: "ap-home" } } };
  delete seeded.gateway;
  const catalog = connectSkillCatalog({
    assistantRuntime: supervisor,
    assistants: { skills: {}, config: {} },
  });
  t.after(() => catalog.close());
  const start = async () => {
    fs.writeFileSync(paths.config, JSON.stringify(seeded));
    await supervisor.stop?.();
    await supervisor.start();
    return readJSON(paths.config).agents.entries["ap-home"].skills;
  };
  return { supervisor, paths, store: catalog.store, start, spawned };
}

test("the start compiles catalog skills and drops damaged, settings and bundled names", async (t) => {
  const { store, start } = catalogStart(t);
  store.write(skillPack("probe"), meta);
  store.write(skillPack("github"), meta);
  assert.deepEqual(await start(), ["other", "probe"]);
  // A copy whose store version is changed as well cannot be restored: never compiled.
  const live = path.join(store.liveRoot, "probe", "SKILL.md");
  for (const file of [
    live,
    path.join(store.storePath("probe", store.byName("probe").digest), "SKILL.md"),
  ]) {
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, "planted");
  }
  assert.deepEqual(await start(), ["other"]);
  assert.equal(store.byName("probe").damaged, true);
  assert.ok(!fs.existsSync(live));
});

test("an unreadable catalog never stops the start and compiles no catalog skill", async (t) => {
  const { store, start, spawned, paths } = catalogStart(t);
  store.write(skillPack("probe"), meta);
  fs.writeFileSync(path.join(paths.skillCatalog, "catalog.json"), "{broken");
  const errors = t.mock.method(console, "error", () => {});
  // Only names the runtime bundles compile while the catalog cannot be read.
  assert.deepEqual(await start(), ["github"]);
  assert.ok(spawned.length > 0, "the Gateway started");
  // Nothing in the catalog's live folder is left for OpenClaw to load.
  assert.deepEqual(fs.readdirSync(store.liveRoot), []);
  assert.ok(
    !errors.mock.calls.some((call) => String(call.arguments[0]).includes(paths.root)),
  );
});
