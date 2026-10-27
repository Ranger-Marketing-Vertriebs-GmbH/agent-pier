import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { mcpUrl } from "../extensions/mcp-config.js";
import { problem } from "../../lib/storage.js";

/**
 * Every environment key AgentPier sets on REA's managed MCP row. The owner cannot
 * override these; any other key on the row belongs to the owner and is never touched.
 */
export const reaManagedKeys = Object.freeze([
  "HOME",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "REA_MCP_INPUT_SCHEMA_PROFILE",
  "REA_ANALYSIS_PROVIDER",
  "GHIDRA_INSTALL_DIR",
  "JAVA_HOME",
  "HOPPER_LAUNCHER_PATH",
  "REA_IDA_MCP_CONFIG",
  "REA_JEB_MCP_URL",
]);

const providers = ["ghidra", "ida"];
const homeDirectories = [
  "tmp",
  ".config",
  ".cache",
  ".local",
  ".local/share",
  ".claude",
  ".codex",
];

/** REA's own home below the data directory: `<dataDir>/rea/home`. */
export function reaHome(dataDir) {
  return path.join(dataDir, "rea", "home");
}

/**
 * Creates REA's home with its tmp, XDG and CLI config directories (0700) and returns
 * it. A link in place of any of them is refused, so REA never writes elsewhere.
 */
export function prepareReaHome(dataDir) {
  const home = reaHome(dataDir);
  for (const directory of [
    path.dirname(home),
    home,
    ...homeDirectories.map((sub) => path.join(home, sub)),
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory())
      throw problem(serverMessages.tools.installationDirectoryInvalid, 409);
    fs.chmodSync(directory, 0o700);
  }
  return home;
}

const empty = (value) => value === undefined || value === null || value === "";

function cleanPath(value) {
  if (empty(value)) return null;
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !path.isAbsolute(value) ||
    /[\x00-\x1f\x7f]/.test(value) ||
    !value.isWellFormed()
  )
    throw problem(serverMessages.rea.invalidPath, 400);
  return value;
}

function cleanUrl(value) {
  if (empty(value)) return null;
  try {
    return mcpUrl(value);
  } catch {
    throw problem(serverMessages.rea.invalidJebUrl, 400);
  }
}

/**
 * The owner's bring-your-own settings, validated: absolute Hopper launcher and IDA MCP
 * config paths, a JEB MCP URL without credentials, and the analysis provider (`ghidra`
 * by default, `ida` only with an IDA config). Empty values clear a setting.
 */
export function cleanReaSettings(input) {
  const source = input && typeof input === "object" ? input : {};
  const provider = empty(source.provider) ? "ghidra" : source.provider;
  if (!providers.includes(provider))
    throw problem(serverMessages.rea.invalidProvider, 400);
  const settings = {
    provider,
    hopperPath: cleanPath(source.hopperPath),
    idaConfig: cleanPath(source.idaConfig),
    jebUrl: cleanUrl(source.jebUrl),
  };
  if (provider === "ida" && !settings.idaConfig)
    throw problem(serverMessages.rea.idaConfigRequired, 400);
  return settings;
}

/**
 * REA's controlled environment: its own HOME, TMPDIR, XDG and CLI config directories
 * (an MCP env entry can only override, so CLAUDE_CONFIG_DIR and CODEX_HOME must point
 * into REA's home), the compact input schema, the provider, Ghidra and its JDK when
 * both are installed (homes from the validated component records) and the owner's
 * bring-your-own settings when set.
 */
export function reaEnvironment({ home, ghidra, jdk, settings }) {
  const env = {
    HOME: home,
    TMPDIR: path.join(home, "tmp"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
    REA_ANALYSIS_PROVIDER: settings.provider,
  };
  if (ghidra?.home && jdk?.home) {
    env.GHIDRA_INSTALL_DIR = ghidra.home;
    env.JAVA_HOME = jdk.home;
  }
  if (settings.hopperPath) env.HOPPER_LAUNCHER_PATH = settings.hopperPath;
  if (settings.idaConfig) env.REA_IDA_MCP_CONFIG = settings.idaConfig;
  if (settings.jebUrl) env.REA_JEB_MCP_URL = settings.jebUrl;
  return env;
}

/**
 * The env patch that turns the row's `current` env into `wanted` for the managed keys
 * only: changed keys get their value, managed keys no longer wanted get null. Owner
 * keys are never named, whatever either side holds.
 */
export function reaEnvPatch(current, wanted) {
  const have = current ?? {};
  const want = wanted ?? {};
  const patch = {};
  for (const key of reaManagedKeys) {
    if (Object.hasOwn(want, key)) {
      if (!Object.hasOwn(have, key) || have[key] !== want[key]) patch[key] = want[key];
    } else if (Object.hasOwn(have, key)) patch[key] = null;
  }
  return patch;
}
