import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn as spawnProcess } from "node:child_process";
import { chromiumEnvironment, chromiumFlags } from "./chromium-launch.js";

// Why an agent browser app cannot start (docs/linux.md "Optional assistants"):
// "sandbox": the system blocks its sandbox (AppArmor's limit on unprivileged user
// namespaces on Ubuntu 23.10 and later, for a Chromium without a setuid helper);
// "missing": the executable cannot be run; "crashed": it ends at once otherwise.
export const launchProblems = ["sandbox", "missing", "crashed"];

const probeTimeoutMs = 20000;
// A failed app is started again at most this often: a fix (an AppArmor profile, a
// system library) changes nothing in the executable itself.
const retryFailedMs = 60000;
const outputLimit = 64 * 1024;
// What Chromium prints when it finds no sandbox it may use ("No usable sandbox!", a
// misconfigured SUID helper, a namespace it may not create).
const sandboxOutput =
  /no usable sandbox|suid sandbox|setuid sandbox|failed to move to new namespace|user namespace/i;

/**
 * The problem of one start that did not end in a page: `error` the spawn error,
 * `output` what the browser wrote to stderr.
 */
export function launchProblem({ error, output = "" }) {
  if (["ENOENT", "EACCES", "ENOEXEC", "ENOTDIR"].includes(error?.code)) return "missing";
  if (sandboxOutput.test(output)) return "sandbox";
  return "crashed";
}

/**
 * One short start of `executablePath`, headless and with the sandbox on (it is never
 * switched off), that prints about:blank's DOM and exits: "ok", a launch problem, or
 * "slow" when it gave no answer within the time limit (a slow host is no defect).
 */
export async function probeLaunch(
  executablePath,
  {
    spawn = spawnProcess,
    platform = process.platform,
    env = process.env,
    timeoutMs = probeTimeoutMs,
  } = {},
) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "agentpier-browser-check-"));
  try {
    return await new Promise((resolve) => {
      let page = "";
      let output = "";
      let child;
      const append = (text, chunk) =>
        text.length < outputLimit ? text + String(chunk) : text;
      const finish = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child?.kill?.("SIGKILL");
        }
        finish("slow");
      }, timeoutMs);
      try {
        child = spawn(
          executablePath,
          [
            `--user-data-dir=${path.join(directory, "user-data")}`,
            ...chromiumFlags({ headless: true, platform }),
            "--dump-dom",
            "about:blank",
          ],
          {
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: chromiumEnvironment({ directory, platform, env }),
          },
        );
      } catch (error) {
        finish(launchProblem({ error }));
        return;
      }
      child.stdout?.on("data", (chunk) => (page = append(page, chunk)));
      child.stderr?.on("data", (chunk) => (output = append(output, chunk)));
      child.once("error", (error) => finish(launchProblem({ error })));
      child.once("close", () =>
        finish(/<html/i.test(page) ? "ok" : launchProblem({ output })),
      );
    });
  } finally {
    await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

// The version of an executable a result belongs to: an update or a replaced file
// changes it, and the browser is checked again.
const fingerprint = (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;

/**
 * Remembers whether each agent browser app starts (AGENTPIER-348). On Linux, a
 * Chromium without a setuid sandbox helper cannot start where AppArmor restricts
 * unprivileged user namespaces; detection (browser-detection.js) then passes over it
 * for the next app that starts and names the problem. Each app is checked once per
 * version (path and file identity), before the agents' browser is first needed; an
 * app that failed is checked again at the next preparation a minute later.
 * `enabled`: only Linux checks; elsewhere every app counts as starting.
 */
export class BrowserLaunchCheck {
  constructor({
    probe = probeLaunch,
    stat = fs.statSync,
    enabled = process.platform === "linux",
    now = Date.now,
  } = {}) {
    Object.assign(this, { probe, stat, enabled, now });
    this.results = new Map();
    this.running = null;
  }
  version(executablePath) {
    try {
      return fingerprint(this.stat(executablePath));
    } catch {
      return null;
    }
  }
  /**
   * What is known of `executablePath`: `{ ok: true }`, `{ ok: false, problem }`, or
   * undefined while it was not checked in its current version.
   */
  result(executablePath) {
    if (!this.enabled || !executablePath) return undefined;
    const known = this.results.get(executablePath);
    if (!known || known.version !== this.version(executablePath)) return undefined;
    return known.problem ? { ok: false, problem: known.problem } : { ok: true };
  }
  /**
   * Checks the apps of `executablePaths` in their order of preference until one
   * starts; apps known in their current version are not started again.
   */
  prepare(executablePaths = []) {
    if (!this.enabled) return Promise.resolve();
    // One check at a time: a second caller waits and then finds the results.
    const run = (this.running || Promise.resolve()).then(() =>
      this.checkAll(executablePaths),
    );
    this.running = run.catch(() => {});
    return run;
  }
  async checkAll(executablePaths) {
    for (const executablePath of executablePaths) {
      const known = this.result(executablePath);
      if (known?.ok) return;
      const checkedAt = this.results.get(executablePath)?.checkedAt ?? -Infinity;
      if (known && this.now() - checkedAt < retryFailedMs) continue;
      const version = this.version(executablePath);
      if (!version) continue;
      let outcome;
      try {
        outcome = await this.probe(executablePath);
      } catch {
        outcome = "crashed";
      }
      const problem = launchProblems.includes(outcome) ? outcome : null;
      this.results.set(executablePath, { version, problem, checkedAt: this.now() });
      if (!problem) return;
    }
  }
}
