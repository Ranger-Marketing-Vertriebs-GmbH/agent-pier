import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse } from "smol-toml";
import { tomlValue } from "../../lib/launch-serialization.js";

const valueOptions = new Set([
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
  "--add-dir",
]);
const permissionKeys = new Set([
  "approval_policy",
  "approvals_reviewer",
  "sandbox_mode",
  "default_permissions",
  "permissions",
  "network",
  "sandbox_workspace_write",
]);
function launchOptions(args) {
  const options = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      options.push(args.slice(i));
      break;
    }
    options.push(
      valueOptions.has(arg) && args[i + 1] !== undefined ? [arg, args[++i]] : [arg],
    );
  }
  return options;
}
function configOverride([arg, value]) {
  return ["-c", "--config"].includes(arg)
    ? value
    : arg.startsWith("--config=")
      ? arg.slice(9)
      : null;
}

// Remote TUIs cannot grant directories. Keep the grant on the owned app-server,
// using the workspace-write configuration supported by older Codex releases too.
export function remoteLaunchArgs(args, { env = process.env, cwd = process.cwd() } = {}) {
  const terminal = [],
    overrides = [],
    directories = [];
  const options = launchOptions(args);
  const resume = options.some(([arg]) => arg === "resume");
  for (const option of options) {
    const [arg, value] = option;
    if (arg === "--") {
      terminal.push(...option);
      break;
    }
    // Remote resume rejects permission flags on the TUI. Keep the launch mode
    // on the owned server, whose defaults also affect resumed threads.
    if (
      resume &&
      ["--yolo", "--dangerously-bypass-approvals-and-sandbox"].includes(arg)
    ) {
      overrides.push(
        "-c",
        'approval_policy="never"',
        "-c",
        'sandbox_mode="danger-full-access"',
      );
      continue;
    }
    const override = configOverride(option);
    if (resume && override && permissionKeys.has(override.split(/[.=]/, 1)[0].trim())) {
      overrides.push(...option);
      continue;
    }
    if (arg === "--add-dir") {
      if (!value) throw Error("Missing Codex additional directory");
      directories.push(path.resolve(cwd, value));
    } else if (arg.startsWith("--add-dir=")) {
      const value = arg.slice("--add-dir=".length);
      if (!value) throw Error("Missing Codex additional directory");
      directories.push(path.resolve(cwd, value));
    } else {
      // Values of other options may look like flags; never reinterpret them.
      terminal.push(...option);
    }
  }
  if (!directories.length) return { terminal, overrides };
  let config = {};
  const home = env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex");
  try {
    config = parse(fs.readFileSync(path.join(home, "config.toml"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let roots = config.sandbox_workspace_write?.writable_roots || [];
  for (const option of options) {
    if (option[0] === "--") break;
    const override = configOverride(option);
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
      ...overrides,
      "-c",
      `sandbox_workspace_write.writable_roots=${tomlValue([...new Set([...roots, ...directories])])}`,
    ],
  };
}
