import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { codexHookCommand } from "../../lib/codex-hook-command.js";
import { shellQuote, tomlValue } from "../../lib/launch-serialization.js";
import {
  failure,
  privateFolder,
  record,
  writePrivateJson,
} from "../memory/memory-validation.js";

const script = fileURLToPath(new URL("./ssh-hook.js", import.meta.url));

// Called with the launch's private args/env copies and the existing Claude plugin folder.
export function prepareSshDiscovery({ tool, folder, args, env }) {
  const invalid = () =>
    Object.assign(failure("SSH discovery hooks could not be configured.", 409), {
      code: "SSH_DISCOVERY_CONFIG",
    });
  if (tool === "opencode") {
    let config;
    try {
      config = record(JSON.parse(env.OPENCODE_CONFIG_CONTENT || "{}"));
      if (
        config.plugin !== undefined &&
        (!Array.isArray(config.plugin) ||
          config.plugin.some((value) => typeof value !== "string"))
      )
        throw Error("Invalid plugins");
    } catch {
      throw invalid();
    }
    const plugin = new URL("./ssh-opencode.js", import.meta.url).href;
    config.plugin = [...new Set([...(config.plugin || []), plugin])];
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
    return;
  }
  const hook = {
    hooks: [
      {
        type: "command",
        command:
          tool === "codex"
            ? codexHookCommand(env, "SSH", script)
            : [process.execPath, script].map(shellQuote).join(" "),
        timeout: 5,
      },
    ],
  };
  if (tool === "codex") {
    const key = "hooks.SessionStart=";
    let index = -1;
    for (let i = 1; i < args.length; i++)
      if (args[i].startsWith(key) && ["-c", "--config"].includes(args[i - 1])) index = i;
    if (index < 0) args.push("-c", key + tomlValue([hook]));
    else {
      let entries;
      try {
        entries = parseToml(args[index]).hooks.SessionStart;
        if (!Array.isArray(entries)) throw Error("Invalid hooks");
      } catch {
        throw invalid();
      }
      args[index] = key + tomlValue([...entries, hook]);
    }
  } else if (tool === "claude") {
    const directory = privateFolder(path.join(folder, "hooks"));
    const file = path.join(directory, "hooks.json");
    let config = {};
    try {
      config = record(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw invalid();
    }
    let hooks;
    try {
      hooks = config.hooks === undefined ? {} : record(config.hooks);
    } catch {
      throw invalid();
    }
    if (hooks.SessionStart !== undefined && !Array.isArray(hooks.SessionStart))
      throw invalid();
    writePrivateJson(file, {
      ...config,
      hooks: { ...hooks, SessionStart: [...(hooks.SessionStart || []), hook] },
    });
  }
}
