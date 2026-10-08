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

const launcher = fileURLToPath(new URL("../../terminal-launcher.js", import.meta.url));

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
    !["codex", "claude", "opencode"].includes(session.tool) ||
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
  if (session.status === "running") {
    await manager.remember(id);
    await manager.tmux(["kill-session", "-t", manager.target(id)]);
  } else await manager.tmux(["kill-session", "-t", manager.target(id)]).catch(() => {});
  manager.pendingTerminalInput?.delete(id);
  session.reload.replacementStarted = true;
  session.status = "stopped";
  delete session.exitCode;
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
    // The route may differ from the first launch (connection edited since).
    if (session.provider)
      session.provider = reloadedProvider(session.provider, launch.provider);
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
      `tuiui-${id}`,
      "-c",
      session.cwd,
      "-x",
      "120",
      "-y",
      "35",
      process.execPath,
      launcher,
      launchFile,
    ]);
    for (const key of [
      "agentbus",
      "memory",
      "nativeBinding",
      "nativeRequests",
      "sshTools",
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
