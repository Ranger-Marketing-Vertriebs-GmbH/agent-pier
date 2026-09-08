import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const launchScript = fileURLToPath(
  new URL("../../server/features/requests/codex-launch.js", import.meta.url),
);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitFor(check) {
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Owned fixture did not reach the expected process state");
}
for (const trigger of ["terminal-exit", "wrapper-term", "wrapper-kill"])
  test(
    `Codex backend descendants are quiescent after ${trigger}`,
    { timeout: 8000 },
    async (t) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-codex-cleanup-"));
      const marker = path.join(dir, "descendant.pid"),
        cli = path.join(dir, "native.cjs"),
        launch = path.join(dir, "launch.json");
      let descendant, wrapper;
      const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        stdio: "ignore",
      });
      t.after(async () => {
        wrapper?.kill("SIGKILL");
        sentinel.kill("SIGKILL");
        if (descendant) {
          try {
            process.kill(descendant, "SIGKILL");
          } catch {}
        }
        for (const name of ["backend.pid", "terminal.pid"]) {
          const pid = Number(
            await fs.readFile(path.join(dir, name), "utf8").catch(() => ""),
          );
          if (pid) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
        }
        await fs.rm(dir, { recursive: true, force: true });
      });
      const stubborn = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`;
      await fs.writeFile(
        cli,
        `#!${process.execPath}\nconst fs=require('node:fs');const{spawn}=require('node:child_process');if(process.argv.includes('app-server')){fs.writeFileSync(${JSON.stringify(path.join(dir, "backend.pid"))},String(process.pid));spawn(process.execPath,['-e',${JSON.stringify(stubborn)}],{stdio:'ignore'});setInterval(()=>{},1000);}else{fs.writeFileSync(${JSON.stringify(path.join(dir, "terminal.pid"))},String(process.pid));setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})&&${JSON.stringify(trigger)}==='terminal-exit')process.exit(0)},10);}`,
        { mode: 0o700 },
      );
      await fs.writeFile(
        launch,
        JSON.stringify({
          id: "fixture",
          token: "fixture",
          command: cli,
          args: [],
          cwd: dir,
          socketPath: path.join(dir, "absent.sock"),
        }),
      );
      wrapper = spawn(process.execPath, [launchScript, launch], {
        env: {
          PATH: process.env.PATH,
          AGENTPIER_REQUEST_FILE: launch,
          AGENTPIER_REQUEST_TOKEN: "fixture",
        },
        stdio: "ignore",
      });
      const exited = once(wrapper, "exit");
      await waitFor(async () => {
        descendant = Number(await fs.readFile(marker, "utf8").catch(() => ""));
        return descendant > 0;
      });
      if (trigger !== "terminal-exit")
        wrapper.kill(trigger === "wrapper-term" ? "SIGTERM" : "SIGKILL");
      await exited;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.equal(
        alive(descendant),
        false,
        "no TERM-ignoring descendant may outlive cleanup",
      );
      assert.equal(alive(sentinel.pid), true, "unrelated process remains alive");
    },
  );
