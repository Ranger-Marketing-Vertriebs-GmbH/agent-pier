import { isMainModule } from "../../lib/is-main-module.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { shellQuote as quote } from "../../lib/launch-serialization.js";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { problem } from "../../lib/storage.js";
import { providerId } from "../chat/provider-history.js";
import {
  ensureDir,
  readJson,
  writeJsonAtomic,
} from "../../../vendor/agentbus/core/fsx.js";
import { pidStart } from "../../../vendor/agentbus/core/proc.js";
import { atLeast } from "../tools/cli-version.js";
import { findRuntimePid } from "../../../vendor/agentbus/hooks/register.js";
import { resolveCodexProcess } from "./native-session-process.js";
import { addGrant } from "../nono/sandbox-grants.js";
import { readNativeActivity, recordNativeActivity } from "./native-session-activity.js";
import { maxReplyText, pushNative } from "../requests/native-push.js";
import { isCodingCli } from "../clis/catalog.js";
import { cliDriver } from "../clis/drivers.js";

export { MESSAGE_DISPLAY_VERSION } from "../clis/claude/binding.js";

const modulePath = fileURLToPath(import.meta.url);
// The binding members of a coding CLI's driver; other tools (shell) have none.
const NO_BINDING = Object.freeze({ idOptional: false });
const bindingOf = (tool) => (isCodingCli(tool) ? cliDriver(tool).binding : NO_BINDING);
const validId = (id) =>
  typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id);

const activityPath = (file) =>
  receiptPath(file).replace(/\.receipt\.json$/, ".activity.json");
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
  else if (!bindingOf(launch.tool).idOptional)
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
    if (selected.tool !== account.tool || !isCodingCli(account.tool))
      throw problem(serverMessages.common.invalidCliProfile);
    const file = this.file(id);
    const canonical = fs.realpathSync(cwd);
    ensureDir(this.directory);
    if (fs.existsSync(file) && !replace)
      throw problem(serverMessages.sessions.nativeBindingAlreadyExists, 409);
    if (replace) {
      this.processCache.clear();
      fs.rmSync(receiptPath(file), { force: true });
      fs.rmSync(activityPath(file), { force: true });
    }
    const token = randomBytes(24).toString("hex");
    const env = {
      ...launch.env,
      AGENTPIER_NATIVE_BINDING_FILE: file,
      AGENTPIER_NATIVE_BINDING_TOKEN: token,
    };
    const args = [...(launch.args || [])];
    cliDriver(account.tool).binding.addHooks(
      { args, env },
      {
        id,
        directory: this.directory,
        script: modulePath,
        cliVersion: launch.cliVersion,
        atLeast,
        pluginUrl: pathToFileURL(
          fileURLToPath(new URL("./native-session-opencode.js", import.meta.url)),
        ).href,
        ensureDir,
        write: writeJsonAtomic,
        quote,
        fail: (key) => problem(serverMessages.sessions[key], 409),
      },
    );
    writeJsonAtomic(file, {
      id,
      accountId: selected.id,
      tool: selected.tool,
      cwd: canonical,
      token,
      createdAt: new Date().toISOString(),
    });
    // The CLI runs this module as a hook subprocess and the hook writes its receipt
    // back into the binding directory next to the plugin and TUI files.
    return [
      { access: "allow", path: this.directory },
      { access: "read", path: process.execPath },
      { access: "read", path: modulePath },
    ].reduce((granted, grant) => addGrant(granted, grant), {
      ...launch,
      args,
      env,
      nativeBinding: { enabled: true, version: 1 },
    });
  }
  async resolve(session, { forInput = false } = {}) {
    const receipt = this.verifiedReceipt(session);
    if (session.tool === "shell" || session.purpose === "login") return null;
    const value = await bindingOf(session.tool).resolve?.(this, session, {
      forInput,
      receipt,
      resolveProcess: resolveCodexProcess,
    });
    if (value) return value;
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
  /** What the CLI last reported about its own activity in this launch. */
  activity(session) {
    if (!session?.nativeBinding?.enabled) return null;
    return readNativeActivity(this.directory, session);
  }
  /**
   * The activity report as the CLI's driver reads it (Claude Code ends a running turn
   * its transcript shows as interrupted with Esc, which sends no hook).
   */
  async reportedActivity(session) {
    const activity = this.activity(session);
    const report = bindingOf(session?.tool).reportedActivity;
    return report ? report(this, session, activity) : activity;
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
      fs.rmSync(activityPath(file), { force: true });
      for (const plugin of [
        `${id}.claude`,
        `${id}.claude-activity`,
        `${id}.claude-stream`,
      ])
        fs.rmSync(path.join(this.directory, plugin), { recursive: true, force: true });
      fs.rmSync(path.join(this.directory, `${id}.tui.json`), { force: true });
    } catch {}
  }
}
// These Claude Code events only report activity; they carry no new identity.
const activityOnly = new Set([
  "MessageDisplay",
  "Stop",
  "StopFailure",
  "PermissionRequest",
  "PreToolUse",
  "Elicitation",
  "SessionEnd",
]);
export async function runNativeSessionHook({
  env = process.env,
  input = process.stdin,
  // The hook process's own start, before this module's imports loaded: the closest
  // AgentPier gets to the event's time (Claude Code's payload carries none).
  at = Math.round(performance.timeOrigin) || Date.now(),
} = {}) {
  const warn = (error) =>
    process.stderr.write(`agentpier-reader: ${String(error.message).slice(0, 240)}\n`);
  let payload;
  try {
    let text = "";
    for await (const chunk of input) {
      text += chunk;
      if (text.length > 1024 * 1024) throw Error("Native hook payload is too large");
    }
    payload = text.trim() ? JSON.parse(text) : {};
  } catch (error) {
    return warn(error);
  }
  if (!activityOnly.has(payload?.hook_event_name))
    try {
      recordNativeSession(payload, env);
    } catch (error) {
      warn(error);
    }
  try {
    // Codex reports its turns through the app-server proxy instead.
    const { tool } = readJson(env.AGENTPIER_NATIVE_BINDING_FILE);
    const activity = bindingOf(tool).hookActivity?.(payload) ?? null;
    if (activity) recordNativeActivity({ ...activity, at }, env);
  } catch (error) {
    warn(error);
  }
  // The receipt and activity files stay for restarts; this push lets an open chat
  // read again at once instead of waiting for the file watcher. Bounded: a stopped
  // server never holds the hook.
  const push = env.AGENTPIER_REQUEST_FILE ? hookPush(payload) : null;
  if (push) await pushNative(push, { env });
}
// Input Claude Code writes itself and submits as a prompt: a background task's or
// subagent's notification, a peer or channel message, a system reminder.
const generatedPrompt =
  /^\s*<(?:task-notification|peer-message|channel-message|system-reminder)[\s>]/;

/**
 * Who submitted a prompt: "owner" (typed in the terminal or sent from AgentPier's
 * chat) or "generated". A payload that names its origin decides; otherwise its text.
 */
export function promptOrigin(payload) {
  const kind = payload?.origin?.kind;
  if (typeof kind === "string") return kind === "human" ? "owner" : "generated";
  return typeof payload?.prompt === "string" && generatedPrompt.test(payload.prompt)
    ? "generated"
    : "owner";
}

/** What a hook payload tells an open chat (native-push.js), or null for nothing. */
export function hookPush(payload) {
  const event = payload?.hook_event_name;
  if (event === "MessageDisplay") {
    // A sub-agent's text is not the session's reply; the transcript keeps it apart.
    if (payload.agent_id) return null;
    return {
      type: "claude-display",
      turnId: payload.turn_id,
      messageId: payload.message_id,
      index: payload.index,
      final: payload.final === true,
      delta:
        typeof payload.delta === "string" ? payload.delta.slice(0, maxReplyText) : "",
    };
  }
  // Claude's StopFailure names a rate limit or an exhausted quota (billing_error).
  const limited =
    event === "StopFailure" && ["rate_limit", "billing_error"].includes(payload.error);
  const detail = [payload.error_details, payload.last_assistant_message].find(
    (value) => typeof value === "string" && value.trim(),
  );
  return {
    type: "activity",
    event,
    ...(event === "UserPromptSubmit" ? { prompt: promptOrigin(payload) } : {}),
    ...(limited
      ? { failure: "usage-limit", ...(detail ? { detail: detail.slice(0, 500) } : {}) }
      : {}),
    ...(event === "Stop" &&
    !payload.agent_id &&
    typeof payload.last_assistant_message === "string"
      ? { lastAssistantMessage: payload.last_assistant_message.slice(0, maxReplyText) }
      : {}),
  };
}

if (isMainModule(import.meta.url) && process.argv[2] === "--record") {
  await runNativeSessionHook();
}
