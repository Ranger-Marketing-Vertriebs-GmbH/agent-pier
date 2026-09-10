import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { detectTools } from "../accounts/account-store.js";
const execute = promisify(execFile);
const pidValue = (value) =>
  Number.isSafeInteger(Number(value)) && Number(value) > 1 ? Number(value) : null;
export function processProbe({
  platform = process.platform,
  procRoot = "/proc",
  run = execute,
} = {}) {
  return {
    async start(pid) {
      try {
        if (platform === "linux") {
          const stat = await fs.readFile(
            path.join(procRoot, String(pid), "stat"),
            "utf8",
          );
          return stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19] || null;
        }
        return (
          (
            await run("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
              timeout: 1500,
              maxBuffer: 65536,
              env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
            })
          ).stdout.trim() || null
        );
      } catch {
        return null;
      }
    },
    async children(pid) {
      if (platform === "linux") {
        try {
          return (
            await fs.readFile(
              path.join(procRoot, String(pid), "task", String(pid), "children"),
              "utf8",
            )
          )
            .trim()
            .split(/\s+/)
            .map(pidValue)
            .filter(Boolean);
        } catch {
          return [];
        }
      }
      try {
        return (
          await run("/usr/bin/pgrep", ["-P", String(pid)], {
            timeout: 1500,
            maxBuffer: 65536,
          })
        ).stdout
          .trim()
          .split(/\s+/)
          .map(pidValue)
          .filter(Boolean);
      } catch {
        return [];
      }
    },
    async executable(pid) {
      if (platform === "linux")
        return fs.readlink(path.join(procRoot, String(pid), "exe"));
      return (
        await run("/bin/ps", ["-p", String(pid), "-o", "comm="], {
          timeout: 1500,
          maxBuffer: 65536,
        })
      ).stdout.trim();
    },
    async files(pid) {
      if (platform === "linux") {
        const dir = path.join(procRoot, String(pid), "fd");
        const files = await fs.readdir(dir);
        return (
          await Promise.all(
            files
              .slice(0, 4096)
              .map((file) => fs.readlink(path.join(dir, file)).catch(() => "")),
          )
        ).filter(Boolean);
      }
      if (platform !== "darwin") return [];
      const { stdout } = await run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-Fn"], {
        timeout: 2500,
        maxBuffer: 2 * 1024 * 1024,
      });
      return stdout
        .split("\n")
        .filter((line) => line.startsWith("n"))
        .map((line) => line.slice(1));
    },
  };
}
async function nativeExecutable(file) {
  if (!file) return null;
  const real = await fs.realpath(file).catch(() => null);
  if (!real) return null;
  if (!real.endsWith(".js")) return real;
  // The official npm entrypoint spawns its platform package binary. Resolve only
  // that documented package layout, never arbitrary launcher code.
  const root = path.dirname(path.dirname(real));
  const manifest = await fs
    .readFile(path.join(root, "package.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  if (manifest?.name !== "@openai/codex" || path.basename(real) !== "codex.js")
    return null;
  const cpu =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;
  const target =
    process.platform === "darwin"
      ? "apple-darwin"
      : process.platform === "linux"
        ? "unknown-linux-musl"
        : null;
  if (!cpu || !target) return null;
  let vendor = path.join(root, "vendor");
  try {
    vendor = path.join(
      path.dirname(
        createRequire(real).resolve(
          `@openai/codex-${process.platform}-${process.arch}/package.json`,
        ),
      ),
      "vendor",
    );
  } catch {}
  for (const directory of ["bin", "codex"]) {
    const binary = await fs
      .realpath(path.join(vendor, `${cpu}-${target}`, directory, "codex"))
      .catch(() => null);
    if (binary) return binary;
  }
  return null;
}
/** Map only an exact native child and its own held writer lock + open rollout. */
export async function resolveCodexProcess(
  session,
  { sessions, accounts, history, probe = processProbe(), executable, verifyRuntime } = {},
) {
  if (
    session.tool !== "codex" ||
    session.status !== "running" ||
    !sessions?.tmux ||
    !sessions?.target ||
    !history?.codexRolloutIdentity
  )
    return null;
  const env = accounts.environment(session.accountId);
  const account = accounts.get(session.accountId);
  if (account.tool !== "codex") return null;
  const expected = await nativeExecutable(
    executable || detectTools(env).find((tool) => tool.id === "codex")?.path,
  );
  if (!expected && !verifyRuntime) return null;
  const pane = pidValue(
    (
      await sessions.tmux([
        "display-message",
        "-p",
        "-t",
        `${sessions.target(session.id)}:0.0`,
        "#{pane_pid}",
      ])
    ).trim(),
  );
  if (!pane) return null;
  let level = [pane];
  let found = [];
  const seen = new Set();
  for (let depth = 0; depth < 8 && level.length; depth++) {
    const next = [];
    for (const pid of level.slice(0, 30)) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const file = await probe
        .executable(pid)
        .then((file) => fs.realpath(file))
        .catch(() => null);
      if (verifyRuntime ? verifyRuntime(pid) : file && file === expected) found.push(pid);
      else next.push(...(await probe.children(pid)));
    }
    if (found.length) break;
    level = next;
  }
  if (found.length !== 1) return null;
  const started = await probe.start(found[0]);
  if (!started) return null;
  if (verifyRuntime && !verifyRuntime(found[0])) return null;
  const files = await probe.files(found[0]);
  const root = await fs
    .realpath(env.CODEX_HOME || path.join(env.HOME, ".codex"))
    .catch(() => null);
  if (!root) return null;
  const locks = new Set();
  const rollouts = [];
  for (const file of files) {
    if (!path.isAbsolute(file)) continue;
    const real = await fs.realpath(file).catch(() => null);
    if (!real || !real.startsWith(root + path.sep)) continue;
    if (
      path.dirname(real) === path.join(root, "thread-writer-locks") &&
      /^[a-zA-Z0-9_-]+\.lock$/.test(path.basename(real))
    )
      locks.add(path.basename(real, ".lock"));
    if (
      real.startsWith(path.join(root, "sessions") + path.sep) &&
      real.endsWith(".jsonl")
    )
      rollouts.push(real);
  }
  const ids = new Set();
  for (const file of new Set(rollouts)) {
    const id = await history.codexRolloutIdentity(session, file).catch(() => null);
    if (id && locks.has(id)) ids.add(id);
  }
  if (ids.size !== 1 || (await probe.start(found[0])) !== started) return null;
  const stillPane = pidValue(
    (
      await sessions.tmux([
        "display-message",
        "-p",
        "-t",
        `${sessions.target(session.id)}:0.0`,
        "#{pane_pid}",
      ])
    ).trim(),
  );
  if (stillPane !== pane || (verifyRuntime && !verifyRuntime(found[0]))) return null;
  return { id: [...ids][0], source: "native-process" };
}
