// The hook side of the native session binding: what a CLI's hook or plugin runs to
// tell AgentPier which native conversation its launch holds.
//
// OpenCode loads this through its TUI plugin, in its own runtime (Bun). Bun finds a
// package named by a bare specifier only when it may list every folder above the
// importing file up to the one that holds `node_modules`; a sandbox does not let it
// list the installation root (docs/sandbox.md), and the plugin would not load. So
// this module and everything it imports names files by relative path or `node:` only,
// and stays clear of the CLI drivers (tests/unit/opencode-plugin-imports.test.js).
import fs from "node:fs";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { providerId } from "../chat/history-files.js";
import { readJson, writeJsonAtomic } from "../../../vendor/agentbus/core/fsx.js";
import { pidStart } from "../../../vendor/agentbus/core/proc.js";
import { findRuntimePid } from "../../../vendor/agentbus/hooks/register.js";
import { pushNative } from "../requests/native-push.js";
import { isLaunchFile } from "./session-own-folder.js";

export const validId = (id) =>
  typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id);

export const activityPath = (file) =>
  receiptPath(file).replace(/\.receipt\.json$/, ".activity.json");
export function receiptPath(file) {
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
  { pid, ps = pidStart, self = process.pid, idOptional = () => false } = {},
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
  else if (!idOptional(launch.tool))
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
