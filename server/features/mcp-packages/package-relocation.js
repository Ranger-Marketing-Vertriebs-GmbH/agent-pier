import fs from "node:fs";
import path from "node:path";
import { toolchainRoot } from "./toolchains.js";
import { logFailure } from "./package-install-job.js";

/** The data directory `toolchainDir` (`<data>/toolchains/<name>`) was recorded in. */
export function recordedDataDir(toolchainDir) {
  if (typeof toolchainDir !== "string" || !path.isAbsolute(toolchainDir)) return null;
  const parent = path.dirname(path.resolve(toolchainDir));
  return path.basename(parent) === "toolchains" ? path.dirname(parent) : null;
}

const moved = (value, from, to) =>
  typeof value === "string" && (value === from || value.startsWith(`${from}/`))
    ? to + value.slice(from.length)
    : value;

const list = (directory) => {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
};

// A PyPI environment links its Python into the toolchain and names it in pyvenv.cfg.
function relinkEnvironment(venv, from, to) {
  const bin = path.join(venv, "bin");
  for (const name of list(bin)) {
    const file = path.join(bin, name);
    if (!fs.lstatSync(file).isSymbolicLink()) continue;
    const target = fs.readlinkSync(file);
    const next = moved(target, from, to);
    if (next === target) continue;
    fs.rmSync(file);
    fs.symlinkSync(next, file);
  }
  const config = path.join(venv, "pyvenv.cfg");
  if (!fs.existsSync(config)) return;
  const text = fs.readFileSync(config, "utf8");
  const next = text.replace(
    /^(\s*[\w-]+\s*=\s*)(\/.*)$/gm,
    (line, key, value) => key + moved(value, from, to),
  );
  if (next !== text) fs.writeFileSync(config, next);
}

// The managed CPython names its folder in sysconfig (cpython-relocation.js) for the
// builds of native extensions; written with the same escaping.
function relocateSysconfig(dataDir, from, to) {
  const escaped = (value) => JSON.stringify(value).slice(1, -1).replaceAll("'", "\\'");
  const old = escaped(toolchainRoot(from) + "/");
  const now = escaped(toolchainRoot(to) + "/");
  for (const toolchain of list(toolchainRoot(dataDir)).filter((name) =>
    name.startsWith("python-"),
  )) {
    const lib = path.join(toolchainRoot(dataDir), toolchain, "cpython", "lib");
    for (const version of list(lib).filter((name) => /^python\d/.test(name)))
      for (const name of list(path.join(lib, version))) {
        if (!/^_sysconfigdata_.*\.py$/.test(name)) continue;
        const file = path.join(lib, version, name);
        const text = fs.readFileSync(file, "utf8");
        if (!text.includes(old)) continue;
        fs.writeFileSync(file, text.replaceAll(old, now));
        const cached = path.join(lib, version, "__pycache__");
        for (const entry of list(cached))
          if (entry.startsWith(`${path.basename(name, ".py")}.`))
            fs.rmSync(path.join(cached, entry), { force: true });
      }
  }
}

/**
 * Packaged MCP servers record absolute paths into the data directory: the toolchain
 * folder, the command and program the server runs (package-store.js npmCommand and
 * pythonCommand), a PyPI environment's link to its Python and CPython's sysconfig.
 * In a data directory moved or copied elsewhere they would start the programs of
 * the first folder, or none (AGENTPIER-467): this points them at `dataDir`. Writes
 * the server rows directly, before agents or CLIs read them; returns whether any
 * server changed, so the caller reconciles the CLIs.
 */
export function relocatePackages({ dataDir, records, servers }) {
  const to = path.resolve(dataDir);
  const sources = new Set();
  let changed = false;
  for (const row of records.all()) {
    const from = recordedDataDir(row.toolchainDir);
    if (!from || from === to) continue;
    sources.add(from);
    // The record moves last: a start that fails before it tries again.
    try {
      if (row.installId && /^[0-9a-f-]{36}$/.test(row.installId))
        relinkEnvironment(
          path.join(to, "mcp-packages", "installs", row.installId, "venv"),
          from,
          to,
        );
      const server = servers.get(row.serverId);
      const patch = {};
      if (moved(server.command, from, to) !== server.command)
        patch.command = moved(server.command, from, to);
      const args = (server.args || []).map((arg) => moved(arg, from, to));
      if (args.some((arg, index) => arg !== server.args[index])) patch.args = args;
      if (moved(server.cwd, from, to) !== server.cwd)
        patch.cwd = moved(server.cwd, from, to);
      if (Object.keys(patch).length) {
        servers.update(row.serverId, { revision: server.revision, ...patch });
        changed = true;
      }
      records.update(row.serverId, { toolchainDir: moved(row.toolchainDir, from, to) });
    } catch (error) {
      logFailure("point a packaged MCP server at this data directory", error);
    }
  }
  for (const from of sources) relocateSysconfig(to, from, to);
  return changed;
}
