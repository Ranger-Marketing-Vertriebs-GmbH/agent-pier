import { listSessions } from "./session-list.js";
import path from "node:path";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { privateWrite } from "./session-process-runtime.js";
import { shellQuote } from "../../lib/launch-serialization.js";
import { problem } from "../../lib/storage.js";
import { validateReloadLaunch } from "../../application/session-reload-launch.js";

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
    throw problem("This session cannot be reloaded.", 409);
  if (session.reload?.state !== "reloading")
    throw problem("Reload intent is missing.", 409);
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
  session.reload.replacementStarted = true;
  session.status = "stopped";
  delete session.exitCode;
  await manager.save(session);
  const launchFile = path.join(manager.directory, `${id}.launch.json`);
  try {
    const launch = await prepare(session);
    await validateReloadLaunch(launch, session.cwd);
    await privateWrite(
      manager.directory,
      `${id}.launch.json`,
      JSON.stringify({
        command: launch.command,
        args: launch.args || [],
        cwd: session.cwd,
        env: { TERM: "xterm-256color", ...launch.env },
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
      [process.execPath, launcher, launchFile].map(shellQuote).join(" "),
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
