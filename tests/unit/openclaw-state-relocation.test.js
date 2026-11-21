// A data directory restored into one folder and started from another keeps working
// from where it is started: the Gateway's state follows the folder (AGENTPIER-467).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { prepareRuntimeConfig } from "../../server/features/assistants/runtimes/openclaw/runtime-config.js";
import { recordedRoot } from "../../server/features/assistants/runtimes/openclaw/state-relocation.js";
import { relocatePaths } from "../../server/lib/relocate-paths.js";
import {
  portableText,
  restoredText,
} from "../../server/features/operations/assistant-backup-paths.js";
import { readJSON, writePrivate } from "../../server/lib/storage.js";

function temp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relocation-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The state an agent leaves behind: its entry, its session index and a config copy.
function seedAgent(paths) {
  const config = readJSON(paths.config);
  config.agents.entries.ag_one = {
    name: "ag_one",
    workspace: path.join(paths.workspaces, "a-1"),
    agentDir: path.join(paths.state, "agents", "ag_one", "agent"),
  };
  writePrivate(paths.config, config);
  writePrivate(`${paths.config}.bak`, config);
  writePrivate(path.join(paths.state, "agents", "ag_one", "sessions", "sessions.json"), {
    main: {
      sessionFile: path.join(paths.state, "agents/ag_one/sessions/s-1.jsonl"),
      cwd: "/Users/someone/project",
    },
  });
}

const mentions = (paths, folder) =>
  [
    paths.config,
    `${paths.config}.bak`,
    path.join(paths.state, "agents", "ag_one", "sessions", "sessions.json"),
  ].filter((file) => fs.readFileSync(file, "utf8").includes(folder));

test("a moved data directory's Gateway state follows it on the next start", (t) => {
  const base = temp(t);
  const first = path.join(base, "instance-data-restored");
  const paths = runtimePaths(first);
  prepareRuntimeConfig(paths, 1234);
  seedAgent(paths);
  const moved = path.join(base, "instance-data");
  fs.renameSync(first, moved);

  const next = runtimePaths(moved);
  prepareRuntimeConfig(next, 1234);
  const config = readJSON(next.config);
  assert.equal(config.agents.defaults.workspace, next.workspaces);
  assert.equal(config.agents.entries.ag_one.workspace, path.join(next.workspaces, "a-1"));
  assert.equal(
    config.agents.entries.ag_one.agentDir,
    path.join(next.state, "agents", "ag_one", "agent"),
  );
  assert.equal(
    readJSON(path.join(next.state, "agents/ag_one/sessions/sessions.json")).main
      .sessionFile,
    path.join(next.state, "agents/ag_one/sessions/s-1.jsonl"),
  );
  // Paths outside the data directory stay as they are.
  assert.equal(
    readJSON(path.join(next.state, "agents/ag_one/sessions/sessions.json")).main.cwd,
    "/Users/someone/project",
  );
  assert.deepEqual(mentions(next, `${first}/`), []);
  // Nothing recreates the old folder.
  assert.equal(fs.existsSync(first), false);
  // A start in place changes nothing.
  const before = fs.readFileSync(next.config, "utf8");
  prepareRuntimeConfig(next, 1234);
  assert.equal(fs.readFileSync(next.config, "utf8"), before);
});

test("a backup restored into one folder and moved works from the new folder", (t) => {
  const base = temp(t);
  const live = runtimePaths(path.join(base, "live"));
  prepareRuntimeConfig(live, 1234);
  seedAgent(live);
  // The archive stores the paths below its marker; a restore resolves them to its target.
  const target = runtimePaths(path.join(base, "restored"));
  for (const file of [
    live.config,
    path.join(live.state, "agents/ag_one/sessions/sessions.json"),
  ]) {
    const relative = path.relative(live.root, file);
    const portable = portableText(fs.readFileSync(file, "utf8"), live.root);
    fs.mkdirSync(path.dirname(path.join(target.root, relative)), { recursive: true });
    fs.writeFileSync(
      path.join(target.root, relative),
      restoredText(portable, target.root),
    );
  }
  assert.equal(recordedRoot(readJSON(target.config)), target.root);
  const moved = path.join(base, "moved");
  fs.renameSync(path.join(base, "restored"), moved);

  const next = runtimePaths(moved);
  prepareRuntimeConfig(next, 1234);
  const config = readJSON(next.config);
  assert.equal(config.agents.entries.ag_one.workspace, path.join(next.workspaces, "a-1"));
  assert.ok(!fs.readFileSync(next.config, "utf8").includes(`${base}/restored/`));
  assert.ok(!fs.readFileSync(next.config, "utf8").includes(`${base}/live/`));
});

test("only the recorded folder and paths below it are rewritten", () => {
  assert.equal(
    recordedRoot({ agents: { defaults: { workspace: "/a/assistants/workspaces/" } } }),
    "/a/assistants",
  );
  assert.equal(
    recordedRoot({ agents: { defaults: { workspace: "relative/workspaces" } } }),
    null,
  );
  assert.equal(
    recordedRoot({ agents: { defaults: { workspace: "/a/elsewhere" } } }),
    null,
  );
  assert.equal(recordedRoot(null), null);
  assert.deepEqual(
    relocatePaths(
      { a: "/old", b: ["/old/x", "/older/y", "/other/old"], c: 1, d: null },
      "/old",
      "/new",
    ),
    { a: "/new", b: ["/new/x", "/older/y", "/other/old"], c: 1, d: null },
  );
});

test("agent entries left on the old folder by an earlier start follow the data directory", (t) => {
  const base = temp(t);
  const first = path.join(base, "instance-data-restored");
  const paths = runtimePaths(first);
  prepareRuntimeConfig(paths, 1234);
  seedAgent(paths);
  const moved = path.join(base, "instance-data");
  fs.renameSync(first, moved);
  const next = runtimePaths(moved);
  // An AgentPier before the fix started here once: it compiled the defaults for this
  // folder and kept every agent entry on the old one.
  const config = readJSON(next.config);
  config.agents.defaults.workspace = next.workspaces;
  writePrivate(next.config, config);

  prepareRuntimeConfig(next, 1234);
  const after = readJSON(next.config);
  assert.equal(after.agents.entries.ag_one.workspace, path.join(next.workspaces, "a-1"));
  assert.equal(
    after.agents.entries.ag_one.agentDir,
    path.join(next.state, "agents", "ag_one", "agent"),
  );
  assert.deepEqual(mentions(next, `${first}/`), []);
  assert.equal(fs.existsSync(first), false);
});
