import { serverMessages } from "../../lib/i18n/de.js";
import { listSessions } from "./session-list.js";
import path from "node:path";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { privateWrite } from "./session-process-runtime.js";
import { problem } from "../../lib/storage.js";
import {
  adapterDiagnosticsPath,
  checkedAdapter,
} from "../adapter-runtime/adapter-config.js";
import { validateReloadLaunch } from "../../application/session-reload-launch.js";
import { reloadedProvider } from "./provider-configuration.js";
import { readTmuxServer } from "./tmux-server-identity.js";
import { tmuxFormatLiteral } from "./tmux-naming.js";
import { sessionSshAgentRecord } from "./session-ssh-agent-record.js";
import { isCodingCli } from "../clis/catalog.js";

const launcher = fileURLToPath(new URL("../../terminal-launcher.js", import.meta.url));
// How long a replacement waits for the old CLI to exit before it prepares the new one.
export const EXIT_WAIT_MS = 5000;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
/** The pid of the session's pane process (its terminal launcher), or null. */
async function panePid(manager, id) {
  try {
    const pid = Number(
      String(
        await manager.tmux([
          "display-message",
          "-p",
          "-t",
          `${manager.target(id)}:0.0`,
          "#{pane_pid}",
        ]),
      ).trim(),
    );
    return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}
/** Resolves once `pid` exited, or after `timeout` ms. */
export async function waitForExit(pid, { timeout = EXIT_WAIT_MS, interval = 50 } = {}) {
  const until = Date.now() + timeout;
  while (alive(pid) && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, interval));
}

export function blocksTerminalInput(session) {
  // The replacement CLI may need hook/trust approval before native verification.
  // The manager separately blocks writes during replacement and disposes old PTYs.
  return (
    session.reload?.state === "reloading" &&
    !(session.reload.replacementStarted && session.status === "running")
  );
}

/** Called inside the manager lock. No stop reconciliation or identity recreation. */
export async function replaceSession(manager, id, prepare, beforeStop) {
  const session = await manager.metadata(id);
  if (
    !isCodingCli(session.tool) ||
    session.purpose ||
    session.pipeline ||
    session.imported?.historyOnly
  )
    throw problem(serverMessages.sessionReload.notReloadable, 409);
  if (session.reload?.state !== "reloading")
    throw problem(serverMessages.sessionReload.intentMissing, 409);
  if (beforeStop)
    await beforeStop(
      session,
      () => manager.capture(id),
      () => listSessions(manager),
    );
  for (const client of [...manager.clients])
    if (client.sessionId === id) client.dispose();
  if (session.status === "running") await manager.remember(id);
  const old = session.status === "running" ? await panePid(manager, id) : null;
  await manager.killSession(id, { strict: session.status === "running" });
  // The old CLI still writes its own configuration while it exits (Claude Code saves
  // .claude.json on exit): the new launch's profile, central MCP entries
  // included, is prepared only once it is gone, so that write cannot undo it. The
  // terminal launcher exits after its CLI.
  if (old) await waitForExit(old, { timeout: manager.exitWaitMs ?? EXIT_WAIT_MS });
  manager.pendingTerminalInput?.delete(id);
  session.reload.replacementStarted = true;
  session.status = "stopped";
  delete session.exitCode;
  // The old CLI is gone: its SSH agent generation signs no more (ssh-session-agents.js).
  // Its socket token stays known (never authorizing), so a failed reload followed by a
  // restart still finds the socket folder to remove.
  const retired = sessionSshAgentRecord(session.sshAgent)?.token;
  if (retired) session.sshAgentRetired = { token: retired };
  delete session.sshAgent;
  await manager.save(session);
  const launchFile = path.join(manager.directory, `${id}.launch.json`);
  try {
    const launch = await prepare(session);
    await validateReloadLaunch(launch, session.cwd);
    const adapter = launch.adapter
      ? checkedAdapter(launch.adapter, manager.directory, id, () =>
          problem(serverMessages.sessions.invalidAdapterConfiguration),
        )
      : null;
    // Diagnostics of the previous generation must not be mistaken for the new adapter.
    // The new generation is recorded first: the old adapter, possibly still shutting
    // down, then refuses its late final write instead of recreating the file.
    if (adapter) session.adapterGeneration = adapter.generation;
    else delete session.adapterGeneration;
    if (typeof launch.cliVersion === "string") session.cliVersion = launch.cliVersion;
    // The route may differ from the first launch (connection edited since).
    if (session.provider)
      session.provider = reloadedProvider(session.provider, launch.provider);
    // Before the CLI starts, so the new agent generation serves its first ssh.
    const sshAgent = sessionSshAgentRecord(launch.sshAgent);
    if (sshAgent) {
      session.sshAgent = sshAgent;
      delete session.sshAgentRetired;
    }
    await manager.save(session);
    await rm(adapterDiagnosticsPath(manager.directory, id), { force: true });
    await privateWrite(
      manager.directory,
      `${id}.launch.json`,
      JSON.stringify({
        command: launch.command,
        args: launch.args || [],
        cwd: session.cwd,
        env: { TERM: "xterm-256color", ...launch.env },
        ...(adapter ? { adapter } : {}),
      }),
    );
    if (launch.accountId) {
      session.deliveryAccountId ||= session.accountId;
      session.accountId = launch.accountId;
      await manager.save(session);
    }
    // Never restore launch input, event streams or delivery payloads.
    await manager.tmux([
      "new-session",
      "-d",
      "-s",
      manager.sessionName(id),
      "-c",
      tmuxFormatLiteral(session.cwd),
      "-x",
      "120",
      "-y",
      "35",
      process.execPath,
      launcher,
      launchFile,
    ]);
    const server = await readTmuxServer(manager).catch(() => null);
    // A stale identity could later flag the relaunched session as interrupted.
    if (server) session.tmuxServer = server;
    else delete session.tmuxServer;
    delete session.interruption;
    for (const key of [
      "agentbus",
      "memory",
      "nativeBinding",
      "nativeRequests",
      "sshTools",
      "secrets",
      "agentpierTools",
      "nativeModelId",
    ])
      if (launch[key] !== undefined) session[key] = launch[key];
    session.status = "running";
    session.restartGeneration = (session.restartGeneration || 0) + 1;
    manager.reconciledStops.delete(id);
    await manager.save(session);
    return session;
  } catch (error) {
    await rm(launchFile, { force: true });
    throw error;
  }
}
