import fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

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
  return /\b(\d+\.\d+\.\d+)\b/.exec(output)?.[1] || null;
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
 * Reads CLI versions with `--version` without blocking the event loop. A result is
 * kept per resolved binary until its modification time or size changes, so an
 * update or a replaced symlink target is probed again. Failed probes are not kept.
 */
export function createCliVersionProbe({ run = runVersion, timeout = 5000 } = {}) {
  const cache = new Map();
  const pending = new Map();
  async function read(command) {
    if (typeof command !== "string" || !command) return null;
    let real, stat;
    try {
      real = await fsp.realpath(command);
      stat = await fsp.stat(real);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    const key = `${real}\0${stat.mtimeMs}\0${stat.size}`;
    const known = cache.get(real);
    if (known?.key === key) return known.version;
    if (pending.has(key)) return pending.get(key);
    const job = run(command, ["--version"], { timeout })
      .then((output) => {
        const version = parseCliVersion(output);
        if (version) cache.set(real, { key, version });
        else cache.delete(real);
        return version;
      })
      .finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  }
  return { read };
}
export const cliVersions = createCliVersionProbe();

/** Version, minimum and state (`ok`, `update-required` or `unknown`) of one CLI. */
export function cliVersionStatus(tool, version) {
  const minimumVersion = MINIMUM_CLI_VERSIONS[tool] || null;
  const found = isCliVersion(version) ? version : null;
  return {
    version: found,
    minimumVersion,
    versionStatus: !found
      ? "unknown"
      : minimumVersion && !atLeast(found, minimumVersion)
        ? "update-required"
        : "ok",
  };
}

/**
 * Refuses a launch of a CLI older than its minimum. An unknown version only warns
 * (the browser shows it from the tool list); it never blocks. `version` skips the
 * probe when the caller already knows it.
 */
export async function requireCliVersion(
  tool,
  command,
  { probe = cliVersions, version } = {},
) {
  const status = cliVersionStatus(
    tool,
    version !== undefined ? version : await probe.read(command),
  );
  if (status.versionStatus === "update-required") {
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

/** The tool list entries with each coding CLI's version state. */
export async function withCliVersions(tools, probe = cliVersions) {
  return Promise.all(
    tools.map(async (tool) =>
      tool.installed && Object.hasOwn(MINIMUM_CLI_VERSIONS, tool.id)
        ? { ...tool, ...cliVersionStatus(tool.id, await probe.read(tool.path)) }
        : tool,
    ),
  );
}
