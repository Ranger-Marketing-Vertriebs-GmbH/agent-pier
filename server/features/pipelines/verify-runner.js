import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { problem } from "../../lib/storage.js";
import { privateRunDirectory, runId } from "./run-store.js";
import { activeNode, currentAttempt } from "./graph-navigation.js";
import { conclude, launchStage, park } from "./execution-stage.js";
const supervisor = fileURLToPath(new URL("./verify-supervisor.js", import.meta.url));
function json(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    // Atomic replacement can unlink the already opened regular inode. Its descriptor
    // remains a valid snapshot; only additional hard links introduce an alias.
    if (!stat.isFile() || stat.nlink > 1 || stat.size > 512 * 1024)
      throw problem("Invalid verification receipt.", 409);
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}
export class VerificationRunner {
  constructor({ directory }) {
    this.directory = privateRunDirectory(path.join(directory, "verification"));
  }
  folder(job) {
    const folder = path.join(this.directory, runId(job.id));
    try {
      const info = fs.lstatSync(folder);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw problem("Unsafe verification job directory.", 409);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return folder;
  }
  async start({ cwd, steps, id = randomUUID(), quiesced = false }) {
    if (
      !Array.isArray(steps) ||
      steps.length > 20 ||
      steps.some(
        (s) =>
          typeof s.command !== "string" ||
          !s.command.trim() ||
          s.command.length > 16384 ||
          !Number.isSafeInteger(s.timeoutMs) ||
          s.timeoutMs < 1 ||
          s.timeoutMs > 7200000,
      ) ||
      steps.reduce((n, s) => n + s.timeoutMs, 0) > 7200000
    )
      throw problem("Invalid verification plan.");
    const job = { id, startedAt: new Date().toISOString() };
    const folder = this.folder(job);
    if (fs.existsSync(folder)) throw problem("Verification job already exists.", 409);
    privateRunDirectory(folder);
    fs.writeFileSync(
      path.join(folder, "request.json"),
      JSON.stringify({ cwd, steps, quiesced: quiesced === true }),
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    const env = Object.fromEntries(
      ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"]
        .filter((k) => process.env[k])
        .map((k) => [k, process.env[k]]),
    );
    const child = spawn(process.execPath, [supervisor, folder], {
      env,
      stdio: "ignore",
      detached: true,
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    return job;
  }
  async inspect(job) {
    const folder = this.folder(job);
    try {
      return json(path.join(folder, "result.json"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    try {
      const pulse = json(path.join(folder, "heartbeat.json"));
      if (Date.now() - pulse.at > 30000)
        return { status: "unavailable", steps: [], quiesced: false };
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      if (Date.now() - Date.parse(job.startedAt) > 10000)
        return { status: "unavailable", steps: [], quiesced: false };
    }
    return { status: "running" };
  }
  async cancel(job) {
    const folder = this.folder(job);
    try {
      fs.writeFileSync(path.join(folder, "cancel"), "cancel", {
        mode: 0o600,
        flag: "wx",
      });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    for (let i = 0; i < 80; i++) {
      const r = await this.inspect(job);
      if (r.status !== "running") return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw problem("Verification cancellation is still pending.", 409);
  }
  async close() {}
}
export async function beginVerification(engine, run, node) {
  let steps;
  try {
    steps = structuredClone(engine.definitions.getVerification(run.projectId).steps);
  } catch (error) {
    engine.recordError(error);
    park(
      engine,
      run,
      node,
      "verify-failed",
      "Verification configuration could not be loaded.",
    );
    return;
  }
  if (!steps.length) {
    node.verifyResult = { status: "not-configured", steps: [], quiesced: false };
    node.verified = true;
    engine.store.save(run);
    await conclude(engine, run, node, node.verdict);
    return;
  }
  const job = { id: randomUUID(), startedAt: engine.now() };
  run.verifyJob = job;
  node.verifyPending = true;
  node.verifyPlan = steps;
  engine.store.save(run);
  try {
    await engine.verify.start({
      id: job.id,
      cwd: run.workingDir,
      steps,
      quiesced: currentAttempt(run)?.quiesced === true,
    });
  } catch (error) {
    engine.recordError(error);
    run.verifyJob = null;
    node.verifyPending = false;
    node.verifyResult = { status: "unavailable", steps: [], quiesced: false };
    park(engine, run, node, "verify-failed", "Verification could not be started.");
  }
}
export async function settleVerification(engine, run) {
  let result;
  try {
    result = await engine.verify.inspect(run.verifyJob);
    if (
      !result ||
      !["running", "pass", "fail", "timed-out", "unavailable"].includes(result.status)
    )
      throw problem("Invalid verification result.", 409);
  } catch (error) {
    engine.recordError(error);
    result = { status: "unavailable", steps: [], quiesced: false };
  }
  if (result.status === "running") return;
  const node = activeNode(run),
    attempt = currentAttempt(run);
  node.verifyResult = result;
  if (attempt) attempt.verifyResult = result;
  node.verifyPending = false;
  run.verifyJob = null;
  if (result.status === "pass") {
    node.verified = true;
    engine.store.save(run);
    await conclude(engine, run, node, node.verdict);
    return;
  }
  if (result.status === "unavailable") {
    park(
      engine,
      run,
      node,
      "verify-failed",
      "Verification did not produce trustworthy completed results.",
    );
    return;
  }
  node.verifyAttempts = (node.verifyAttempts || 0) + 1;
  if (node.verifyAttempts <= 2) {
    const queued = {
      nodeId: node.id,
      kind: "verify-feedback",
      ...(node.nativeId ? { resumeNativeId: node.nativeId } : {}),
      feedback:
        "Verification did not pass. Correct the cause or explain the existing/environmental failure without weakening checks. Untrusted check output:\n" +
        JSON.stringify(result.steps).slice(0, 24000),
    };
    run.pendingTurn = queued;
    engine.store.save(run);
    await launchStage(engine, run, node, queued);
    return;
  }

  park(
    engine,
    run,
    node,
    "verify-failed",
    "Verification still failed after three attempts.",
  );
}
