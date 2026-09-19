import path from "node:path";
import { rm } from "node:fs/promises";
import { problem as failure } from "../../lib/storage.js";
export function removeSession(manager, id) {
  return manager.serial(async () => {
    const session = await manager.current(id);
    if (session.status === "running")
      throw failure("Stop the running session before deleting it", 409);
    await manager.tmux(["kill-session", "-t", manager.target(id)]).catch(() => {});
    await manager.onRemoving(session);
    for (const extension of [
      "json",
      "screen",
      "launch.json",
      "events.jsonl",
      "outcome.json",
    ])
      await rm(path.join(manager.directory, `${id}.${extension}`), {
        force: true,
      });
  }, id);
}
