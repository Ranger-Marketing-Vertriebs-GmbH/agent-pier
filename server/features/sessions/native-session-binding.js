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
import { resolveRuntime } from "./native-session-runtime.js";
import { addGrant } from "../nono/sandbox-grants.js";
import { readNativeActivity, recordNativeActivity } from "./native-session-activity.js";
import { maxReplyText, pushNative } from "../requests/native-push.js";
import { isCodingCli } from "../clis/catalog.js";
import { cliDriver } from "../clis/drivers.js";
import { isLaunchFile, ownFolder, sessionFolder } from "./session-own-folder.js";

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
    !isLaunchFile(file, "native-sessions")
  )
    throw problem(serverMessages.sessions.invalidNativeBinding);
  return file.replace(/\.launch\.json$/, ".receipt.json");
}
/**
 * Writes the launch's receipt: this native conversation runs in the CLI process
 * `pid`, started at `pidStart`, in this launch (its token) and project.
 *
 * A sandbox may deny reading the process list (nono denies the setuid `ps` on
 * macOS). Then no process can be read, this one (`self`) included, and the error
 * carries `processUnreadable`: the caller asks the server to write the receipt
 * (`claimNativeSession`).
 */
export function recordNativeSession(
  data,
  env = process.env,
  { pid, ps = pidStart, self = process.pid } = {},
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
    throw Object.assign(problem(serverMessages.sessions.nativeProcessStopped), {
      processUnreadable: !ps(self),
    });
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
/**
 * Asks the server for the receipt a hook cannot write itself (see
 * `recordNativeSession`), over the session's request channel. The hook names its own
 * process; the server, outside the sandbox, finds the CLI above it and writes the
 * receipt (`NativeSessionBinding.claim`). False when there is no channel, the server
 * does not answer in time or it refuses.
 */
export async function claimNativeSession(
  data,
  env = process.env,
  { pid = process.pid, timeout = 2500 } = {},
) {
  if (!env.AGENTPIER_REQUEST_FILE || !env.AGENTPIER_NATIVE_BINDING_TOKEN) return false;
  const reply = await pushNative(
    {
      type: "binding",
      token: env.AGENTPIER_NATIVE_BINDING_TOKEN,
      providerSessionId: data?.session_id ?? data?.sessionId ?? data?.thread_id ?? null,
      cwd: data?.cwd ?? null,
      pid,
    },
    { env, timeout, reply: "binding-result" },
  );
  return reply?.ok === true;
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
  /** The launch file of the session's current launch (session-own-folder.js). */
  file(id) {
    if (!validId(id)) throw problem(serverMessages.common.invalidSessionId);
    return path.join(sessionFolder(this.directory, id), `${id}.launch.json`);
  }
  /** Removes what a launch from before the session had a folder of its own left. */
  discardShared(id) {
    const flat = path.join(this.directory, `${id}.launch.json`);
    for (const file of [flat, receiptPath(flat), activityPath(flat)])
      fs.rmSync(file, { force: true });
    for (const plugin of [`${id}.claude`, `${id}.claude-activity`, `${id}.claude-stream`])
      fs.rmSync(path.join(this.directory, plugin), { recursive: true, force: true });
    fs.rmSync(path.join(this.directory, `${id}.tui.json`), { force: true });
  }
  async prepare({ id, account, cwd, launch, purpose, replace = false } = {}) {
    if (purpose === "login" || account?.tool === "shell")
      return { ...launch, nativeBinding: { enabled: false, version: 1 } };
    const selected = this.accounts.get(account?.id);
    if (selected.tool !== account.tool || !isCodingCli(account.tool))
      throw problem(serverMessages.common.invalidCliProfile);
    if (fs.existsSync(this.file(id)) && !replace)
      throw problem(serverMessages.sessions.nativeBindingAlreadyExists, 409);
    const canonical = fs.realpathSync(cwd);
    // Everything of this launch lives in the session's own folder, the only part of
    // the shared one a sandboxed session is granted.
    const own = ownFolder(this.directory, id);
    const file = path.join(own, `${id}.launch.json`);
    ensureDir(own);
    if (replace) {
      this.processCache.clear();
      this.discardShared(id);
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
        directory: own,
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
    // and activity through a temporary file next to the plugin and TUI files, so the
    // session's own folder is writable; the other sessions' folders are not granted.
    return [
      { access: "allow", path: own },
      { access: "read", path: process.execPath },
      { access: "read", path: modulePath },
    ].reduce((granted, grant) => addGrant(granted, grant), {
      ...launch,
      args,
      env,
      nativeBinding: { enabled: true, version: 1 },
    });
  }
  /**
   * A hook's claim (`claimNativeSession`), answered for the request broker. The
   * receipt is the one the hook would have written and proves the same: the claim
   * carries the launch's token and project, the server reads the CLI process from
   * the session's own pane instead of taking the hook's word (`resolveRuntime`), and
   * a CLI that was replaced while the claim ran, or a second live one, gets none.
   */
  async claim(sessionId, { token, providerSessionId, cwd, pid }) {
    let ok = false;
    try {
      const session = await this.sessions.get(sessionId);
      if (session.status !== "running" || !session.nativeBinding?.enabled) throw Error();
      const proof = await (this.processOptions.resolveRuntime || resolveRuntime)({
        session,
        claimedPid: pid,
        sessions: this.sessions,
        accounts: this.accounts,
      });
      const started = (id) => {
        const start = pidStart(id);
        return id === proof.pid && start !== proof.pidStart ? null : start;
      };
      recordNativeSession(
        { session_id: providerSessionId, ...(cwd ? { cwd } : {}) },
        {
          AGENTPIER_NATIVE_BINDING_FILE: this.file(sessionId),
          AGENTPIER_NATIVE_BINDING_TOKEN: token,
        },
        { pid: proof.pid, ps: started },
      );
      ok = true;
    } catch {}
    return { reply: { type: "binding-result", ok } };
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
      if (!validId(id)) return;
      this.discardShared(id);
      fs.rmSync(ownFolder(this.directory, id), { recursive: true, force: true });
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
  ps,
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
      recordNativeSession(payload, env, { ps });
    } catch (error) {
      if (!error.processUnreadable || !(await claimNativeSession(payload, env)))
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
