import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { spawnNativeProcess } from "../../server/features/pipelines/native-process.js";
import { shellQuote } from "../../server/lib/launch-serialization.js";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function waitFor(check, message) {
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

for (const [kind, target] of [
  ["pipeline", "keeper"],
  ["verification", "keeper"],
  ["codex-backend", "keeper"],
  ["pipeline", "watchdog"],
])
  test(`${kind}: killing the ${target} stops its native descendants`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-group-crash-"));
    const marker = path.join(root, "pids.json");
    const native = path.join(root, "native.cjs");
    const env = { PATH: process.env.PATH, HOME: root };
    let keeper, pids;
    const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      env,
      stdio: "ignore",
    });
    t.after(async () => {
      keeper?.kill("SIGKILL");
      sentinel.kill("SIGKILL");
      for (const pid of Object.values(pids || {})) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await fs.rm(root, { recursive: true, force: true });
    });
    // Both processes ignore TERM. The grandchild confirms its handler is installed
    // before the native process exposes the fixture's identities to the test.
    await fs.writeFile(
      native,
      `const fs=require('node:fs');const{spawn}=require('node:child_process');
process.on('SIGTERM',()=>{});
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
child.once('message',()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({native:process.pid,descendant:child.pid})));
setInterval(()=>{},1000);`,
    );
    if (kind === "pipeline") {
      keeper = spawnNativeProcess({
        command: process.execPath,
        args: [native],
        cwd: root,
        env,
        initialInput: "fixture",
      }).child;
    } else {
      let args;
      if (kind === "verification") {
        const request = path.join(root, "request.json");
        await fs.writeFile(
          request,
          JSON.stringify({
            cwd: root,
            steps: [{ command: [process.execPath, native].map(shellQuote).join(" ") }],
          }),
        );
        args = [
          fileURLToPath(
            new URL(
              "../../server/features/pipelines/verify-executor.js",
              import.meta.url,
            ),
          ),
          request,
          "0",
        ];
      } else {
        args = [
          fileURLToPath(
            new URL(
              "../../server/features/requests/codex-owned-backend.js",
              import.meta.url,
            ),
          ),
        ];
      }
      keeper = spawn(process.execPath, args, {
        cwd: root,
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });
      if (kind === "codex-backend")
        keeper.once("spawn", () =>
          keeper.send({ command: process.execPath, args: [native], cwd: root }),
        );
    }
    keeper.stdout.resume();
    keeper.stderr.resume();
    await waitFor(async () => {
      pids = await fs.readFile(marker, "utf8").then(JSON.parse, () => null);
      return pids !== null;
    }, "Native fixture did not start");
    assert.equal(alive(pids.native), true);
    assert.equal(alive(pids.descendant), true);
    if (target === "watchdog") {
      const children = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/).map(Number))
        .filter(([pid, parent]) => parent === keeper.pid && pid !== pids.native);
      assert.equal(children.length, 1, "one watchdog shares the native process's parent");
      process.kill(children[0][0], "SIGKILL");
    } else {
      keeper.kill("SIGKILL");
    }
    await waitFor(
      () => !alive(pids.native) && !alive(pids.descendant),
      `Native descendants survived their ${target}'s SIGKILL`,
    );
    assert.equal(alive(sentinel.pid), true, "unrelated process remains alive");
  });
