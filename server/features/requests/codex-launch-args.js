import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse } from "smol-toml";
import { tomlValue } from "../../lib/launch-serialization.js";

// Remote TUIs cannot grant directories. Keep the grant on the owned app-server,
// using the workspace-write configuration supported by older Codex releases too.
export function remoteLaunchArgs(args, { env = process.env, cwd = process.cwd() } = {}) {
  const terminal = [],
    directories = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      terminal.push(...args.slice(i));
      break;
    }
    if (arg === "--add-dir") {
      if (!args[i + 1]) throw Error("Missing Codex additional directory");
      directories.push(path.resolve(cwd, args[++i]));
    } else if (arg.startsWith("--add-dir=")) {
      const value = arg.slice("--add-dir=".length);
      if (!value) throw Error("Missing Codex additional directory");
      directories.push(path.resolve(cwd, value));
    } else {
      terminal.push(arg);
      // Values of other options may look like flags; never reinterpret them.
      if (
        [
          "-c",
          "--config",
          "-m",
          "--model",
          "-p",
          "--profile",
          "--enable",
          "--disable",
          "-C",
          "--cd",
          "-i",
          "--image",
        ].includes(arg) &&
        args[i + 1] !== undefined
      )
        terminal.push(args[++i]);
    }
  }
  if (!directories.length) return { terminal, overrides: [] };
  let config = {};
  const home = env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex");
  try {
    config = parse(fs.readFileSync(path.join(home, "config.toml"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let roots = config.sandbox_workspace_write?.writable_roots || [];
  for (let i = 0; i < terminal.length; i++) {
    const arg = terminal[i];
    if (arg === "--") break;
    const override = ["-c", "--config"].includes(arg)
      ? terminal[++i]
      : arg.startsWith("--config=")
        ? arg.slice(9)
        : null;
    if (!override || !/^sandbox_workspace_write(?:\.writable_roots)?\s*=/.test(override))
      continue;
    const parsed = parse(override);
    if (parsed.sandbox_workspace_write?.writable_roots !== undefined)
      roots = parsed.sandbox_workspace_write.writable_roots;
  }
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string"))
    throw Error("Invalid Codex writable roots");
  return {
    terminal,
    overrides: [
      "-c",
      `sandbox_workspace_write.writable_roots=${tomlValue([...new Set([...roots, ...directories])])}`,
    ],
  };
}
