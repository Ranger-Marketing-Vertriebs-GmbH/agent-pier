import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { privateFolder, problem, writePrivateText } from "../../lib/storage.js";
import { craftHome } from "./craft-home.js";

export { craftHome };

/** Environment keys AgentPier sets on Craft Anything's managed MCP row. */
export const craftManagedKeys = Object.freeze([
  "CRAFT_ANYTHING_CONFIG_DIR",
  "CRAFT_ANYTHING_NO_KEYCHAIN",
]);

const stubText = `#!/bin/sh
echo "Ghidra is not installed. Install it in AgentPier: CLIs and extensions › Installation › Craft Anything." >&2
exit 1
`;

/** The config directory of the MCP session row. */
export function sessionsConfigDir(dataDir) {
  return path.join(craftHome(dataDir), "sessions");
}

/** The config directory of the rebuild supervisor's own MCP children. */
export function rebuildsConfigDir(dataDir) {
  return path.join(craftHome(dataDir), "rebuilds");
}

/** The environment AgentPier sets on the session row. */
export function craftEnvironment(dataDir) {
  return {
    CRAFT_ANYTHING_CONFIG_DIR: sessionsConfigDir(dataDir),
    CRAFT_ANYTHING_NO_KEYCHAIN: "1",
  };
}

const unsafe = () => problem(serverMessages.tools.installationDirectoryInvalid, 409);

/**
 * Writes the executable placeholder Craft Anything gets as its Ghidra directory while
 * Ghidra is missing, so it never searches the home folder. Returns its path.
 */
export function ensureGhidraStub(dataDir) {
  const home = craftHome(dataDir);
  fs.mkdirSync(path.dirname(home), { recursive: true, mode: 0o700 });
  privateFolder(home, unsafe);
  const file = path.join(home, "no-ghidra");
  writePrivateText(file, stubText, 0o700);
  return file;
}

function readConfig(file) {
  try {
    const value = parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/**
 * Craft Anything builds with a coding agent only once one is configured: it does not
 * pick up `claude` from PATH by itself (`ai detect` merely suggests it). Rebuilds get
 * Claude Code as an `agent_cli` backend; an entry the owner or Craft Anything already
 * made for it stays as it is.
 */
function withClaudeCode(ai) {
  const section = ai && typeof ai === "object" ? ai : {};
  const backends = Array.isArray(section.backends) ? section.backends : [];
  if (backends.some((item) => item?.kind === "agent_cli" && item.model === "claude-code"))
    return { ...section, backends };
  return {
    ...section,
    backends: [
      ...backends,
      { enabled: true, kind: "agent_cli", model: "claude-code", name: "Claude Code" },
    ],
  };
}

/**
 * Pins AgentPier's keys in Craft Anything's config.toml and keeps all others. An
 * unreadable file is replaced. A linked config directory is refused. `builder` also
 * configures Claude Code as the backend that builds (the rebuilds' directory).
 */
export function writeCraftConfig(configDir, { ghidra, jdk, stub, builder = false }) {
  fs.mkdirSync(path.dirname(configDir), { recursive: true, mode: 0o700 });
  privateFolder(configDir, unsafe);
  const file = path.join(configDir, "config.toml");
  const config = readConfig(file);
  const engines =
    config.engines && typeof config.engines === "object" ? config.engines : {};
  const engine =
    engines.ghidra && typeof engines.ghidra === "object" ? engines.ghidra : {};
  engine.install_dir = ghidra ? ghidra.home : stub;
  if (ghidra && jdk) engine.java_home = jdk.home;
  else delete engine.java_home;
  config.auto_mode = false;
  config.deep_mode = false;
  config.engines = { ...engines, ghidra: engine };
  if (builder) config.ai = withClaudeCode(config.ai);
  writePrivateText(file, stringify(config));
}
