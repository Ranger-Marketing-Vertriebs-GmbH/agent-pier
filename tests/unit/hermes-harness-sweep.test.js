import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { sweepHarnessDirs } from "../../server/features/assistants/runtimes/hermes/hermes-harness-sweep.js";
import {
  harnessRuntimeDir,
  hermesEnvironment,
} from "../../server/features/assistants/runtimes/hermes/hermes-environment.js";

// At its start AgentPier removes the browser engine folders (/tmp/aph-<12 hex>) a
// process set left behind when AgentPier ended without stopping it, and ends the
// engine daemons listed in them. It touches only this user's private folders, and
// only those of its own data directory's agents (none runs yet) or of homes that no
// longer exist: another AgentPier's running agent keeps its own.

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sweep-"));
  const dataDir = path.join(root, "data");
  const homes = path.join(dataDir, "assistants", "hermes", "home");
  fs.mkdirSync(path.join(homes, "ap-1"), { recursive: true });
  const other = path.join(root, "other-data", "assistants", "hermes", "home", "ap-9");
  fs.mkdirSync(other, { recursive: true });
  const tmp = path.join(root, "tmp");
  fs.mkdirSync(tmp);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dataDir, home: path.join(homes, "ap-1"), other, tmp };
}

// A folder as hermesEnvironment claims it, below `tmp` instead of /tmp.
function folder(tmp, home, { mode = 0o700, marker = true } = {}) {
  const dir = path.join(tmp, path.basename(harnessRuntimeDir(home)));
  fs.mkdirSync(dir, { mode });
  fs.chmodSync(dir, mode);
  if (marker)
    fs.writeFileSync(path.join(dir, "agentpier.json"), JSON.stringify({ home }));
  return dir;
}

test("hermesEnvironment marks its folder with the agent's home", (t) => {
  const home = `/data/agents/ap-${process.pid}-mark`;
  const env = hermesEnvironment({
    agent: { home, hermesHome: `${home}/state`, tmp: `${home}/tmp` },
    runtime: { pythonPath: "/install/venv/bin/python" },
    parent: {},
  });
  t.after(() => fs.rmSync(env.BH_RUNTIME_DIR, { recursive: true, force: true }));
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(env.BH_RUNTIME_DIR, "agentpier.json"), "utf8")),
    { home },
  );
});

test("the start sweep ends leftover daemons and removes only stale private folders", async (t) => {
  const { dataDir, home, other, tmp, root } = setup(t);
  const own = folder(tmp, home);
  const gone = folder(tmp, path.join(root, "deleted", "ap-2"));
  const unmarked = folder(tmp, path.join(root, "unmarked"), { marker: false });
  const foreign = folder(tmp, other);
  const open = folder(tmp, path.join(root, "open"), { mode: 0o755 });
  const unrelated = path.join(tmp, "aph-not-ours");
  fs.mkdirSync(unrelated, { mode: 0o700 });
  const daemon = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", "browser_harness.daemon"],
    { detached: true, stdio: "ignore" },
  );
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  t.after(() => {
    for (const child of [daemon, bystander])
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        /* Gone. */
      }
  });
  await delay(200);
  fs.writeFileSync(path.join(own, "bu-local-1.pid"), `${daemon.pid}\n`);
  fs.writeFileSync(path.join(own, "bu-local-2.pid"), `${bystander.pid}\n`);
  const removed = sweepHarnessDirs({ dataDir, root: tmp });
  assert.deepEqual(removed.sort(), [gone, own, unmarked].sort());
  for (let n = 0; n < 50 && alive(daemon.pid); n++) await delay(50);
  assert.equal(alive(daemon.pid), false);
  assert.equal(alive(bystander.pid), true);
  for (const dir of [own, gone, unmarked]) assert.equal(fs.existsSync(dir), false, dir);
  // Another data directory's agent, a folder others may enter and a name that is
  // not AgentPier's stay.
  for (const dir of [foreign, open, unrelated])
    assert.equal(fs.existsSync(dir), true, dir);
});
