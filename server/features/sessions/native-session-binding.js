import { isMainModule } from "../../lib/is-main-module.js";
import { serverMessages } from "../../lib/i18n/de.js";
import {
  shellQuote as quote,
  tomlValue as toml,
} from "../../lib/launch-serialization.js";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseToml } from "smol-toml";
import { problem } from "../../lib/storage.js";
import { providerId } from "../chat/provider-history.js";
import {
  ensureDir,
  readJson,
  writeJsonAtomic,
} from "../../../vendor/agentbus/core/fsx.js";
import { pidStart } from "../../../vendor/agentbus/core/proc.js";
import { findRuntimePid } from "../../../vendor/agentbus/hooks/register.js";
import { resolveCodexProcess } from "./native-session-process.js";

const modulePath = fileURLToPath(import.meta.url);
const validId = (id) =>
  typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id);

function receiptPath(file) {
  if (
    typeof file !== "string" ||
    !path.isAbsolute(file) ||
    !validId(path.basename(file, ".launch.json")) ||
    !file.endsWith(".launch.json") ||
    path.basename(path.dirname(file)) !== "native-sessions"
  )
    throw problem(serverMessages.sessions.invalidNativeBinding);
  return file.replace(/\.launch\.json$/, ".receipt.json");
}
export function recordNativeSession(
  data,
  env = process.env,
  { pid, ps = pidStart } = {},
) {
  const file = env.AGENTPIER_NATIVE_BINDING_FILE;
  const output = receiptPath(file);
  const launch = readJson(file);
  if (
    launch.token !== env.AGENTPIER_NATIVE_BINDING_TOKEN ||
    !validId(launch.id) ||
    path.basename(file) !== `${launch.id}.launch.json`
  )
    throw problem(serverMessages.sessions.invalidNativeBindingKey);
  const id = data?.session_id ?? data?.sessionId ?? data?.thread_id ?? null;
  if (id !== null) providerId(id);
  else if (launch.tool !== "opencode")
    throw problem(serverMessages.sessions.nativeSessionIdMissing);
  if (fs.realpathSync(data?.cwd || launch.cwd) !== launch.cwd)
    throw problem(serverMessages.sessions.nativeProjectMismatch);
  if (!pid) {
    try {
      pid = findRuntimePid(launch.tool);
    } catch {
      pid = process.ppid;
    }
  }
  const started = ps(pid);
  if (!Number.isInteger(pid) || pid <= 0 || !started)
    throw problem(serverMessages.sessions.nativeProcessStopped);
  let previous;
  try {
    previous = readJson(output);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (
    previous?.pid !== undefined &&
    previous.pid !== pid &&
    ps(previous.pid) === previous.pidStart
  )
    throw problem(serverMessages.sessions.nativeProcessAlreadyBound);
  writeJsonAtomic(output, {
    id: launch.id,
    accountId: launch.accountId,
    tool: launch.tool,
    cwd: launch.cwd,
    token: launch.token,
    providerSessionId: id,
    pid,
    pidStart: started,
    updatedAt: new Date().toISOString(),
  });
}
export class NativeSessionBinding {
  constructor({ dataDir, accounts, sessions, history, processOptions = {} }) {
    this.dataDir = fs.realpathSync(dataDir);
    this.directory = path.join(this.dataDir, "native-sessions");
    this.accounts = accounts;
    this.sessions = sessions;
    this.history = history;
    this.processOptions = processOptions;
    this.processCache = new Map();
  }
  file(id) {
    if (!validId(id)) throw problem(serverMessages.common.invalidSessionId);
    return path.join(this.directory, `${id}.launch.json`);
  }
  async prepare({ id, account, cwd, launch, purpose, replace = false } = {}) {
    if (purpose === "login" || account?.tool === "shell")
      return { ...launch, nativeBinding: { enabled: false, version: 1 } };
    const selected = this.accounts.get(account?.id);
    if (
      selected.tool !== account.tool ||
      !["claude", "codex", "opencode"].includes(account.tool)
    )
      throw problem(serverMessages.common.invalidCliProfile);
    const file = this.file(id);
    const canonical = fs.realpathSync(cwd);
    ensureDir(this.directory);
    if (fs.existsSync(file) && !replace)
      throw problem(serverMessages.sessions.nativeBindingAlreadyExists, 409);
    if (replace) {
      this.processCache.clear();
      fs.rmSync(receiptPath(file), { force: true });
    }
    const token = randomBytes(24).toString("hex");
    const env = {
      ...launch.env,
      AGENTPIER_NATIVE_BINDING_FILE: file,
      AGENTPIER_NATIVE_BINDING_TOKEN: token,
    };
    const args = [...(launch.args || [])];
    const hook = {
      hooks: [
        {
          type: "command",
          command: [process.execPath, modulePath, "--record"].map(quote).join(" "),
          timeout: 5,
        },
      ],
    };
    if (account.tool === "codex")
      for (const event of ["SessionStart", "UserPromptSubmit"]) {
        const key = `hooks.${event}=`;
        let index = -1;
        for (let i = 0; i < args.length; i++)
          if (args[i].startsWith(key) && ["-c", "--config"].includes(args[i - 1]))
            index = i;
        if (index >= 0) {
          let entries;
          try {
            entries = parseToml(args[index]).hooks[event];
          } catch {
            throw problem(serverMessages.sessions.codexHooksCannotBeMerged, 409);
          }
          if (!Array.isArray(entries))
            throw problem(serverMessages.sessions.unknownCodexHookFormat, 409);
          args[index] = key + toml([...entries, hook]);
        } else args.push("-c", key + toml([hook]));
      }
    if (account.tool === "claude") {
      if (!args.includes("--session-id") && !args.includes("--resume"))
        args.push("--session-id", id);
      // Capture /clear and native resume events as well as the explicitly assigned launch ID.
      const directory = path.join(this.directory, `${id}.claude`);
      ensureDir(path.join(directory, ".claude-plugin"));
      ensureDir(path.join(directory, "hooks"));
      writeJsonAtomic(path.join(directory, ".claude-plugin/plugin.json"), {
        name: "agentpier-reader",
        version: "1.0.0",
        description: "Native session identity for the AgentPier reader",
      });
      writeJsonAtomic(path.join(directory, "hooks/hooks.json"), {
        hooks: { SessionStart: [hook], UserPromptSubmit: [hook] },
      });
      args.push("--plugin-dir", directory);
    }
    if (account.tool === "opencode") {
      if (env.OPENCODE_TUI_CONFIG)
        throw problem(serverMessages.sessions.temporaryTuiConfigConflict, 409);
      const config = path.join(this.directory, `${id}.tui.json`);
      writeJsonAtomic(config, {
        plugin: [
          pathToFileURL(
            fileURLToPath(new URL("./native-session-opencode.js", import.meta.url)),
          ).href,
        ],
      });
      env.OPENCODE_TUI_CONFIG = config;
    }
    writeJsonAtomic(file, {
      id,
      accountId: selected.id,
      tool: selected.tool,
      cwd: canonical,
      token,
      createdAt: new Date().toISOString(),
    });
    return {
      ...launch,
      args,
      env,
      nativeBinding: { enabled: true, version: 1 },
    };
  }
  async resolve(session, { forInput = false } = {}) {
    const receipt = this.verifiedReceipt(session);
    if (session.tool === "shell" || session.purpose === "login") return null;
    if (session.tool === "codex" && this.accounts && this.sessions && this.history) {
      const cacheKey = JSON.stringify([
        session.id,
        session.accountId,
        session.cwd,
        session.status,
      ]);
      const cached = this.processCache.get(cacheKey);
      if (!forInput && cached && Date.now() - cached.time < 2000) {
        if (cached.value) return cached.value;
      } else {
        let value = null;
        try {
          value = await resolveCodexProcess(session, {
            sessions: this.sessions,
            accounts: this.accounts,
            history: this.history,
            ...this.processOptions,
            verifyRuntime: receipt
              ? (pid) => pid === receipt.pid && pidStart(pid) === receipt.pidStart
              : undefined,
          });
        } catch {}
        this.processCache.set(cacheKey, { time: Date.now(), value });
        if (value) return value;
      }
    }
    if (forInput) return null;
    return receipt
      ? {
          id:
            receipt.providerSessionId === null
              ? null
              : providerId(receipt.providerSessionId),
          updatedAt: receipt.updatedAt,
        }
      : null;
  }
  verifiedReceipt(session) {
    try {
      const file = this.file(session.id);
      const launch = readJson(file);
      const receipt = readJson(receiptPath(file));
      if (
        launch.id !== session.id ||
        launch.accountId !== session.accountId ||
        launch.tool !== session.tool ||
        launch.cwd !== fs.realpathSync(session.cwd) ||
        receipt.id !== launch.id ||
        receipt.accountId !== launch.accountId ||
        receipt.tool !== launch.tool ||
        receipt.cwd !== launch.cwd ||
        receipt.token !== launch.token
      )
        throw Error("Unverified native receipt");
      if (
        !Number.isInteger(receipt.pid) ||
        !receipt.pidStart ||
        !receipt.updatedAt ||
        !Number.isFinite(Date.parse(receipt.updatedAt))
      )
        throw Error("Unverified native receipt");
      if (session.status === "running" && pidStart(receipt.pid) !== receipt.pidStart)
        throw Error("Unverified native receipt");
      if (receipt.providerSessionId !== null) providerId(receipt.providerSessionId);
      return receipt;
    } catch {}
    return null;
  }
  async discard(id) {
    try {
      const file = this.file(id);
      fs.rmSync(file, { force: true });
      fs.rmSync(receiptPath(file), { force: true });
      fs.rmSync(path.join(this.directory, `${id}.claude`), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(this.directory, `${id}.tui.json`), { force: true });
    } catch {}
  }
}
export async function runNativeSessionHook() {
  try {
    let text = "";
    for await (const chunk of process.stdin) {
      text += chunk;
      if (text.length > 1024 * 1024) throw Error("Native hook payload is too large");
    }
    recordNativeSession(text.trim() ? JSON.parse(text) : {});
  } catch (error) {
    process.stderr.write(`agentpier-reader: ${String(error.message).slice(0, 240)}\n`);
  }
}

if (isMainModule(import.meta.url) && process.argv[2] === "--record") {
  await runNativeSessionHook();
}
