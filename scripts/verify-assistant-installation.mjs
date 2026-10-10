import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { isMainModule } from "../server/lib/is-main-module.js";
import { runtimeManifest } from "../server/features/assistants/runtime-manifest.js";
import { stageAssistantRuntime } from "../server/features/assistants/runtime-install.js";
import { RuntimeSupervisor } from "../server/features/assistants/runtime-supervisor.js";
import { GatewayClient } from "../server/features/assistants/gateway-client.js";
import { runtimePaths } from "../server/features/assistants/runtime-paths.js";
import { runtimeEnvironment } from "../server/features/assistants/runtime-config.js";
import { readJSON } from "../server/lib/storage.js";

const repository = path.resolve(import.meta.dirname, "..");

const diagnosticCodes = new Set([
  "UNAVAILABLE",
  "TIMEOUT",
  "CLOSED",
  "UNAUTHORIZED",
  "PROTOCOL_MISMATCH",
  "PROCESS_EXIT",
  "PROCESS_START",
  "START_FAILED",
  "INVALID_CONFIG",
  "OWNERSHIP_CONFLICT",
  "CONNECTION_LOST",
  "ECONNREFUSED",
  "EADDRINUSE",
  "ENOENT",
  "EACCES",
  "ERR_ASSERTION",
]);
const safeCode = (code) =>
  code == null ? null : diagnosticCodes.has(code) ? code : "OTHER";
const availability = new Set([
  "disabled",
  "installing",
  "starting",
  "ready",
  "stopping",
  "failed",
  "reconnecting",
]);

function consoleSummary(runtime) {
  let descriptor;
  try {
    descriptor = fs.openSync(path.join(runtime.paths.logs, "gateway-console.log"), "r");
    const bytes = fs.fstatSync(descriptor).size;
    const sample = Buffer.alloc(Math.min(bytes, 65536));
    const sampledBytes = fs.readSync(
      descriptor,
      sample,
      0,
      sample.length,
      bytes - sample.length,
    );
    const output = sample.toString("utf8", 0, sampledBytes);
    // Only fixed category names leave the disposable runtime; never log text,
    // config, addresses, credentials, plugin names or filesystem paths.
    const categories = [
      ["plugins", /\[plugins\]/i],
      ["gateway", /\[gateway\]/i],
      ["listening", /listening on/i],
      ["config-invalid", /invalid config|config(?:uration)? validation failed/i],
      ["address-in-use", /EADDRINUSE/],
      ["permission-denied", /EACCES|EPERM/],
      ["module-missing", /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/],
      ["out-of-memory", /heap out of memory|allocation failed/i],
      ["fatal-error", /FATAL ERROR|uncaught exception/i],
    ]
      .filter(([, pattern]) => pattern.test(output))
      .map(([category]) => category);
    return { bytes, sampledBytes, truncated: bytes > sampledBytes, categories };
  } catch (error) {
    return { readError: safeCode(error.code) };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function createQualificationDiagnostics(
  runtime,
  { report = (record) => console.log(JSON.stringify(record)) } = {},
) {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let activePhase = null;
  const emit = (event, data = {}) =>
    report({ event, phase: activePhase, elapsedMs: elapsed(), ...data });
  const state = (status) => ({
    availability: availability.has(status?.availability)
      ? status.availability
      : "unknown",
    diagnostic: safeCode(status?.diagnostic),
  });
  const onStatus = (status) => emit("runtime-status", state(status));
  runtime.on("status", onStatus);
  const originalSpawn = runtime.spawn;
  runtime.spawn = function (...args) {
    const child = originalSpawn.apply(this, args);
    emit("child-created", { hasPid: Number.isInteger(child.pid) });
    child.once("spawn", () => emit("child-spawned"));
    child.once("error", (error) =>
      emit("child-error", { errorCode: safeCode(error.code) }),
    );
    child.once("exit", (code, signal) =>
      emit("child-exit", {
        exitCode: Number.isInteger(code) ? code : null,
        signal: ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGILL", "SIGBUS"].includes(
          signal,
        )
          ? signal
          : signal
            ? "OTHER"
            : null,
      }),
    );
    return child;
  };
  return {
    async phase(name, operation) {
      activePhase = name;
      const phaseStarted = performance.now();
      emit("phase-started");
      try {
        const result = await operation();
        emit("phase-complete", {
          durationMs: Math.round(performance.now() - phaseStarted),
        });
        return result;
      } catch (error) {
        emit("phase-failed", {
          durationMs: Math.round(performance.now() - phaseStarted),
          errorCode: safeCode(error.code),
          ...state(runtime.status()),
          console: consoleSummary(runtime),
        });
        throw error;
      }
    },
    close() {
      runtime.off("status", onStatus);
      runtime.spawn = originalSpawn;
    },
  };
}

// A separate process group lets cancellation stop npm and any descendants as well.
export function runQualificationCommand(
  command,
  args,
  { timeout = 60000, signal, ...options } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Error("Qualification command cancelled."));
    const child = spawn(command, args, {
      ...options,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      bytes = 0,
      failure;
    const stop = (message) => {
      failure ||= Error(message);
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") child.kill("SIGKILL");
        }
      }
    };
    const cancel = () => stop("Qualification command cancelled.");
    const timer = setTimeout(() => stop("Qualification command timed out."), timeout);
    signal?.addEventListener("abort", cancel, { once: true });
    const capture = (chunk, stdout) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) stop("Qualification command output exceeded limit.");
      else if (stdout) output += chunk;
    };
    child.stdout.on("data", (chunk) => capture(chunk, true));
    child.stderr.on("data", (chunk) => capture(chunk, false));
    child.once("error", () => {
      failure ||= Error("Qualification command failed to start.");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (failure || code !== 0)
        reject(failure || Error(`Qualification command failed (exit ${code}).`));
      else resolve(output);
    });
  });
}

async function assertRoster(runtime, agentId) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const roster = await runtime.client.call("agents.list", {});
    if (roster.agents?.some((agent) => agent.id === agentId)) return;
    await delay(100);
  }
  assert.fail("Synthetic agent did not appear in the authenticated Gateway roster.");
}

// Exported so the Gateway contract can also be exercised with immutable binaries
// and newly generated state, independently of the network-dependent installation.
export async function qualifyInstalledGateway(
  runtime,
  { verifyStage = async () => {}, phase = async (_name, operation) => operation() } = {},
) {
  await phase("initial-start", () => runtime.start());
  assert.equal(runtime.client.ready, true);
  assert.equal(runtime.status().availability, "ready");
  const unauthorized = new GatewayClient({
    url: runtime.client.url,
    certPath: runtime.client.certPath,
    token: "intentionally-invalid-qualification-token",
  });
  try {
    await phase("reject-unauthorized", () =>
      // Rejected by the authenticated Gateway itself, not by certificate pinning.
      assert.rejects(
        unauthorized.connect(),
        (error) => error.code !== "ENDPOINT_UNTRUSTED",
      ),
    );
    assert.equal(unauthorized.ready, false);
  } finally {
    unauthorized.close();
  }
  const agentId = "installation-qualification";
  const created = await phase("create-agent", () =>
    runtime.client.call("agents.create", {
      name: agentId,
      workspace: path.join(runtime.paths.workspaces, agentId),
    }),
  );
  assert.equal(created.agentId, agentId);
  await phase("initial-roster", () => assertRoster(runtime, agentId));
  const session = await phase("create-session", () =>
    runtime.client.call("sessions.create", {
      agentId,
      label: "Installation qualification",
    }),
  );
  assert.ok(session.key);
  assert.notEqual(session.runStarted, true);
  const message = "AGENTPIER_INSTALLATION_SYNTHETIC_HISTORY_4729";
  await phase("inject-history", () =>
    runtime.client.call("chat.inject", {
      sessionKey: session.key,
      message,
      label: "No model inference",
    }),
  );
  const history = async () => {
    const result = await runtime.client.call("chat.history", {
      sessionKey: session.key,
      limit: 20,
    });
    assert.ok(JSON.stringify(result.messages).includes(message));
    return result;
  };
  const before = await phase("initial-history", history);
  const pid = runtime.child.pid;
  await phase("cached-stage", verifyStage);
  assert.equal(runtime.child.pid, pid, "staging must preserve the active process");
  assert.equal(runtime.client.ready, true);
  await phase("restart", () => runtime.restart());
  assert.equal(runtime.client.ready, true);
  assert.notEqual(runtime.child.pid, pid);
  await phase("restored-roster", () => assertRoster(runtime, agentId));
  const after = await phase("restored-history", history);
  assert.deepEqual(after.messages, before.messages);
  assert.equal(after.sessionId, before.sessionId);
  const sessions = await phase("restored-sessions", () =>
    runtime.client.call("sessions.list", {}),
  );
  assert.ok(sessions.sessions.some((entry) => entry.key === session.key));
}

export async function qualifyFreshInstallation() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-installation-"));
  const controller = new AbortController();
  let runtime, diagnostics;
  const cancel = () => {
    controller.abort();
    void runtime?.close();
  };
  const deadline = setTimeout(cancel, 15 * 60000);
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const paths = runtimePaths(dataDir);
    const env = {
      HOME: paths.home,
      TMPDIR: paths.tmp,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      LANG: "en_US.UTF-8",
    };
    console.log(
      `Installing fresh managed runtime for ${process.platform}-${process.arch}.`,
    );
    const output = await runQualificationCommand(
      process.execPath,
      ["scripts/install-assistant-runtime.mjs", "--data-dir", dataDir],
      { cwd: repository, env, timeout: 12 * 60000, signal: controller.signal },
    );
    const installed = JSON.parse(output.trim());
    const directory = path.dirname(path.dirname(path.dirname(installed.nodePath)));
    const receipt = readJSON(path.join(directory, "receipt.json"));
    assert.equal(installed.version, runtimeManifest.version);
    assert.equal(installed.nodeVersion, runtimeManifest.nodeVersion);
    assert.ok(runtimeManifest.dependencyLockSha256);
    assert.equal(receipt.dependencyLockSha256, runtimeManifest.dependencyLockSha256);
    const versionEnv = runtimeEnvironment(paths, installed.nodePath, "qualification");
    const version = (args) =>
      runQualificationCommand(installed.nodePath, args, {
        cwd: paths.root,
        env: versionEnv,
        signal: controller.signal,
      }).then((value) => value.trim());
    assert.equal(await version(["--version"]), `v${runtimeManifest.nodeVersion}`);
    const npm = path.resolve(
      installed.nodePath,
      "../../lib/node_modules/npm/bin/npm-cli.js",
    );
    assert.equal(await version([npm, "--version"]), runtimeManifest.npmVersion);
    const openclawVersion = await version([installed.entryPath, "--version"]);
    assert.equal(
      /^OpenClaw (\S+)(?: \([a-f0-9]+\))?$/.exec(openclawVersion)?.[1],
      runtimeManifest.version,
    );
    assert.equal(
      readJSON(path.join(path.dirname(installed.entryPath), "package.json")).version,
      runtimeManifest.version,
    );
    console.log("Exact managed Node, npm, OpenClaw and dependency lock verified.");
    const selectionFile = path.join(paths.root, "runtime.json");
    const selected = fs.readFileSync(selectionFile, "utf8");
    const receiptBefore = fs.readFileSync(path.join(directory, "receipt.json"), "utf8");
    const entryBefore = fs.statSync(installed.entryPath);
    runtime = new RuntimeSupervisor({ dataDir });
    diagnostics = createQualificationDiagnostics(runtime);
    await qualifyInstalledGateway(runtime, {
      phase: diagnostics.phase,
      verifyStage: async () => {
        const forbidden = async () => {
          assert.fail(
            "Reusing an installed runtime must not download or execute installs.",
          );
        };
        const staged = await stageAssistantRuntime({
          dataDir,
          download: forbidden,
          execute: forbidden,
        });
        assert.equal(staged.nodePath, installed.nodePath);
        assert.equal(staged.entryPath, installed.entryPath);
        assert.equal(fs.readFileSync(selectionFile, "utf8"), selected);
        assert.equal(
          fs.readFileSync(path.join(directory, "receipt.json"), "utf8"),
          receiptBefore,
        );
        assert.equal(fs.statSync(installed.entryPath).mtimeMs, entryBefore.mtimeMs);
        assert.equal(fs.statSync(installed.entryPath).ino, entryBefore.ino);
        assert.ok(
          !fs.readdirSync(paths.runtimes).some((name) => name.startsWith(".stage-")),
        );
      },
    });
    controller.signal.throwIfAborted();
    assert.equal(fs.readFileSync(selectionFile, "utf8"), selected);
    console.log(
      "Authenticated Gateway, cached staging, agent, session and history restart verified.",
    );
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    await runtime?.close();
    diagnostics?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  if (process.argv.length !== 2)
    throw Error("Usage: node scripts/verify-assistant-installation.mjs");
  await qualifyFreshInstallation();
}
