import fs from "node:fs";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { randomBytes } from "node:crypto";
import { readJson } from "../../../vendor/agentbus/core/fsx.js";

// Activity a CLI reports about itself: hooks (Claude Code), the app-server proxy
// (Codex) or the TUI plugin (OpenCode). "ended" means the CLI said goodbye, so the
// reader falls back to the terminal again.
export const nativeActivityStates = ["working", "idle", "waiting", "ended"];
const events = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "PermissionRequest",
  "PreToolUse",
  "Elicitation",
  "SessionEnd",
  "turn/started",
  "turn/completed",
  "thread/status/changed",
  "session.status",
]);
const validId = (id) =>
  typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id);

function bindingFiles(file) {
  if (
    typeof file !== "string" ||
    !path.isAbsolute(file) ||
    !file.endsWith(".launch.json") ||
    path.basename(path.dirname(file)) !== "native-sessions" ||
    !validId(path.basename(file, ".launch.json"))
  )
    throw problem(serverMessages.sessions.invalidNativeBinding);
  return { launch: file, activity: file.replace(/\.launch\.json$/, ".activity.json") };
}

/** Map one Claude Code hook payload to an activity, or null when it says nothing new. */
export function claudeHookActivity(payload) {
  const event = payload?.hook_event_name;
  if (event === "SessionStart")
    // Compaction can run inside a turn; it does not mean the CLI went idle.
    return payload.source === "compact" ? null : { state: "idle", event };
  if (event === "UserPromptSubmit") return { state: "working", event };
  if (event === "Stop") {
    const tasks = Array.isArray(payload.background_tasks) ? payload.background_tasks : [];
    const background = tasks.filter(
      (task) => !["completed", "failed", "killed", "stopped"].includes(task?.status),
    ).length;
    return background
      ? { state: "working", event, background: Math.min(background, 1000) }
      : { state: "idle", event };
  }
  if (event === "StopFailure") return { state: "idle", event };
  if (event === "PermissionRequest" || event === "Elicitation")
    return { state: "waiting", event };
  if (event === "PreToolUse")
    return payload.tool_name === "AskUserQuestion" ? { state: "waiting", event } : null;
  if (event === "SessionEnd") return { state: "ended", event };
  return null;
}

/** Store the latest activity next to the binding receipt; older reports never win. */
export function recordNativeActivity(
  { state, event, background = 0, at = Date.now() },
  env = process.env,
) {
  if (!nativeActivityStates.includes(state) || !events.has(event))
    throw Error("Invalid native activity");
  const files = bindingFiles(env.AGENTPIER_NATIVE_BINDING_FILE);
  const launch = readJson(files.launch);
  if (
    launch.token !== env.AGENTPIER_NATIVE_BINDING_TOKEN ||
    path.basename(files.launch) !== `${launch.id}.launch.json`
  )
    throw problem(serverMessages.sessions.invalidNativeBindingKey);
  // Async hooks may finish out of order; the event time decides, not the write.
  const newer = () => {
    try {
      const previous = readJson(files.activity);
      return previous?.token === launch.token && Date.parse(previous.at) > at;
    } catch {
      return false;
    }
  };
  if (newer()) return false;
  const value = {
    id: launch.id,
    accountId: launch.accountId,
    tool: launch.tool,
    token: launch.token,
    state,
    event,
    background: Number.isInteger(background)
      ? Math.max(0, Math.min(background, 1000))
      : 0,
    at: new Date(at).toISOString(),
  };
  // Write a private temporary file, check again, then rename over the report. Two
  // writers can still both pass the second check within the same few microseconds;
  // the next event (or the terminal fallback) corrects such a report.
  const temporary = path.join(
    path.dirname(files.activity),
    `.tmp-activity-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    if (newer()) return false;
    fs.renameSync(temporary, files.activity);
    return true;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** The current launch's own report, or null for older sessions and foreign files. */
export function readNativeActivity(directory, session) {
  try {
    if (!validId(session?.id)) return null;
    const files = bindingFiles(path.join(directory, `${session.id}.launch.json`));
    if (!fs.existsSync(files.activity)) return null;
    const launch = readJson(files.launch);
    const value = readJson(files.activity);
    const at = Date.parse(value.at);
    if (
      launch.id !== session.id ||
      launch.accountId !== session.accountId ||
      launch.tool !== session.tool ||
      value.id !== launch.id ||
      value.accountId !== launch.accountId ||
      value.tool !== launch.tool ||
      value.token !== launch.token ||
      !nativeActivityStates.includes(value.state) ||
      !events.has(value.event) ||
      !Number.isFinite(at)
    )
      return null;
    return {
      state: value.state,
      event: value.event,
      background: Number.isInteger(value.background) ? value.background : 0,
      at,
    };
  } catch {
    return null;
  }
}
