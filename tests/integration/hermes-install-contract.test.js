import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { hermesExecutables } from "../../server/features/assistants/runtimes/hermes/hermes-paths.js";
import { hermesManifest } from "../../server/features/assistants/runtimes/hermes/hermes-manifest.js";

// Native Hermes contract: AGENTPIER_HERMES_CONTRACT_RUNTIME names an installation
// that scripts/provision-hermes-contracts.mjs made from the pinned manifest.
const runtime = process.env.AGENTPIER_HERMES_CONTRACT_RUNTIME;
const skip = runtime ? false : "AGENTPIER_HERMES_CONTRACT_RUNTIME is not set";

function privateEnvironment(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-install-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["home", "hermes", "tmp", "work"])
    fs.mkdirSync(path.join(root, name));
  return {
    root,
    env: {
      HOME: path.join(root, "home"),
      HERMES_HOME: path.join(root, "hermes"),
      TMPDIR: path.join(root, "tmp"),
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
    },
  };
}

test(
  "the pinned installation runs hermes and the stdio TUI-RPC server",
  { skip, timeout: 120000 },
  async (t) => {
    const { python, hermes } = hermesExecutables(runtime);
    const { root, env } = privateEnvironment(t);
    const version = execFileSync(hermes, ["--version"], {
      env,
      cwd: path.join(root, "work"),
      encoding: "utf8",
    });
    assert.match(
      version,
      new RegExp(`\\(${hermesManifest.releaseDate.replaceAll(".", "\\.")}\\)`),
    );
    assert.match(
      version,
      new RegExp(`Python: ${hermesManifest.pythonVersion.replaceAll(".", "\\.")}`),
    );
    const child = spawn(python, ["-m", "tui_gateway.entry"], {
      env,
      cwd: path.join(root, "work"),
      stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(() => child.exitCode === null && child.kill("SIGKILL"));
    const lines = createInterface({ input: child.stdout });
    const ready = await new Promise((resolve, reject) => {
      child.once("exit", (code) => reject(Error(`exited ${code}`)));
      lines.on("line", (line) => {
        const frame = JSON.parse(line);
        if (frame.method === "event" && frame.params?.type === "gateway.ready")
          resolve(frame);
      });
    });
    assert.equal(ready.jsonrpc, "2.0");
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "gateway.capabilities", params: {} })}\n`,
    );
    const answer = await new Promise((resolve) =>
      lines.on("line", (line) => {
        const frame = JSON.parse(line);
        if (frame.id === 1) resolve(frame);
      }),
    );
    assert.ok(answer.result, JSON.stringify(answer));
    child.stdin.end();
    assert.equal(await new Promise((resolve) => child.once("exit", resolve)), 0);
    // Everything Hermes wrote stayed in the private home.
    assert.ok(fs.existsSync(path.join(env.HERMES_HOME, "state.db")));
  },
);
