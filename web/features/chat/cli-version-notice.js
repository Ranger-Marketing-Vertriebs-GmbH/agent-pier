import {
  atLeast,
  isCliVersion,
} from "../../../server/features/tools/cli-version-compare.js";

/**
 * Whether a running session's CLI is older than AgentPier supports, and how to
 * update it. `session.cliVersion` is the version the session started with; `tool`
 * is the CLI's entry of the workspace state (live `state` topic): its minimum, the
 * version installed now, and whether AgentPier manages it or how it was installed.
 * Null for an unknown version (an external install that cannot be read), and once
 * the installed CLI is current again: the next reload starts that version.
 * `method` is `managed` (the update dialog), `homebrew` or `npm` with their
 * `command`, or `unknown`.
 */
export function outdatedCli(session, tool) {
  if (!session || !tool || session.tool !== tool.id || session.status !== "running")
    return null;
  const required = tool.minimumVersion;
  const found = session.cliVersion;
  if (!isCliVersion(required) || !isCliVersion(found) || atLeast(found, required))
    return null;
  if (atLeast(tool.version, required)) return null;
  const managed = tool.managedInstall === true;
  const command = managed ? null : tool.updateCommand || null;
  const method = managed
    ? "managed"
    : command && ["homebrew", "npm"].includes(tool.installMethod)
      ? tool.installMethod
      : "unknown";
  return { tool: tool.id, found, required, method, command };
}
