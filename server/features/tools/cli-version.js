import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { planToolUpdate } from "./tool-update.js";

/**
 * The oldest release of each coding CLI that AgentPier starts sessions with. These
 * are the versions its launch flags, history parsers, model menus and update
 * commands were verified against (docs/cli-updates.md explains each one). A CLI
 * without an entry is never blocked. The table moves into the CLI definition
 * record later, so it stays the only place that names these versions.
 */
export const MINIMUM_CLI_VERSIONS = Object.freeze({
  codex: "0.153.4",
  claude: "2.1.263",
  opencode: "1.18.29",
});
const CLI_NAMES = { codex: "Codex", claude: "Claude Code", opencode: "OpenCode" };

const triple = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(typeof version === "string" ? version : "");
  return match ? match.slice(1).map(Number) : null;
};

/** The first `major.minor.patch` in a CLI's `--version` output, or null. */
export function parseCliVersion(output) {
  if (typeof output !== "string") return null;
  return /(?<![\d.])(\d+\.\d+\.\d+)/.exec(output)?.[1] || null;
}
export const isCliVersion = (version) => triple(version) !== null;

/** Whether `version` is `minimum` or newer; an unparseable version never is. */
export function atLeast(version, minimum) {
  const found = triple(version),
    required = triple(minimum);
  if (!found || !required) return false;
  for (let index = 0; index < 3; index++)
    if (found[index] !== required[index]) return found[index] > required[index];
  return true;
}

function runVersion(command, args, { timeout }) {
  return new Promise((resolve) => {
    let output = "",
      settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn(command, args, {
        stdio: ["ignore", "pipe", "ignore"],
        env: { PATH: process.env.PATH || "/usr/bin:/bin" },
      });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 32768) {
        child.kill("SIGKILL");
        finish(null);
      }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? output : null));
  });
}

/**
 * Reads CLI versions with `--version` without blocking the event loop. A result,
 * also a failed one, is kept per resolved binary until its modification time or
 * size changes, so an update or a replaced symlink target is probed again while a
 * broken `--version` is not respawned on every poll. Concurrent reads share a run.
 */
export function createCliVersionProbe({ run = runVersion, timeout = 5000 } = {}) {
  const cache = new Map();
  const pending = new Map();
  async function identify(command) {
    if (typeof command !== "string" || !command) return null;
    try {
      const real = await fsp.realpath(command);
      const stat = await fsp.stat(real);
      return stat.isFile()
        ? { real, key: `${real}\0${stat.mtimeMs}\0${stat.size}` }
        : null;
    } catch {
      return null;
    }
  }
  function start(command, { real, key }, limit) {
    if (pending.has(key)) return pending.get(key);
    const job = Promise.resolve(run(command, ["--version"], { timeout: limit }))
      .catch(() => null)
      .then((output) => {
        const version = parseCliVersion(output);
        cache.set(real, { key, version });
        return version;
      })
      .finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  }
  /**
   * The version, probing when nothing is known for this binary. `refresh` runs
   * the probe again although a failure is cached, with its own `timeout`.
   */
  async function read(command, { refresh = false, timeout: limit = timeout } = {}) {
    const binary = await identify(command);
    if (!binary) return null;
    const known = cache.get(binary.real);
    if (known?.key === binary.key && !(refresh && known.version === null))
      return known.version;
    return start(command, binary, limit);
  }
  /**
   * What is known without waiting: `{ settled, version }`. An unknown binary is
   * probed in the background, so a later call has its result.
   */
  async function peek(command) {
    const binary = await identify(command);
    if (!binary) return { settled: true, version: null };
    const known = cache.get(binary.real);
    if (known?.key === binary.key) return { settled: true, version: known.version };
    start(command, binary, timeout);
    return { settled: false, version: null };
  }
  return { read, peek };
}
export const cliVersions = createCliVersionProbe();

/**
 * Version, minimum and state of one CLI: `ok`, `update-required`, `unknown`, or
 * `checking` while its first probe still runs.
 */
export function cliVersionStatus(tool, version, { checking = false } = {}) {
  const minimumVersion = MINIMUM_CLI_VERSIONS[tool] || null;
  const found = isCliVersion(version) ? version : null;
  return {
    version: found,
    minimumVersion,
    versionStatus: checking
      ? "checking"
      : !found
        ? "unknown"
        : minimumVersion && !atLeast(found, minimumVersion)
          ? "update-required"
          : "ok",
  };
}

/**
 * Whether AgentPier can update this executable itself (native installation in the
 * server home or its own npm installation), so a launch may wait for that update.
 */
export function isManagedInstall(tool, command, { home, dataDir }) {
  try {
    planToolUpdate(tool, home, path.join(dataDir, "clis"), {
      installed: true,
      path: command,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuses a launch of a managed CLI older than its minimum. An external CLI below
 * its minimum and an unknown version only warn (the browser shows both from the
 * tool list): AgentPier cannot update them, so blocking would leave no way out.
 * `version` skips the probe when the caller already knows it.
 */
export async function requireCliVersion(
  tool,
  command,
  { probe = cliVersions, version, managed = true } = {},
) {
  const status = cliVersionStatus(
    tool,
    version !== undefined ? version : await probe.read(command),
  );
  if (status.versionStatus === "update-required" && managed) {
    const updateRequired = {
      tool,
      found: status.version,
      required: status.minimumVersion,
    };
    throw Object.assign(
      problem(
        serverMessages.tools.cliUpdateRequired(
          CLI_NAMES[tool] || tool,
          updateRequired.found,
          updateRequired.required,
        ),
        409,
      ),
      { code: "CLI_UPDATE_REQUIRED", updateRequired },
    );
  }
  return status;
}

/**
 * The tool list entries with each coding CLI's version state and whether AgentPier
 * manages its installation. Without `wait` it never waits for a probe: polled
 * lists show `checking` until the background probe has finished.
 */
export async function withCliVersions(
  tools,
  { probe = cliVersions, wait = false, managed = () => false } = {},
) {
  return Promise.all(
    tools.map(async (tool) => {
      if (!tool.installed || !Object.hasOwn(MINIMUM_CLI_VERSIONS, tool.id)) return tool;
      const { settled, version } = wait
        ? { settled: true, version: await probe.read(tool.path) }
        : await probe.peek(tool.path);
      return {
        ...tool,
        ...cliVersionStatus(tool.id, version, { checking: !settled }),
        managedInstall: managed(tool),
      };
    }),
  );
}
