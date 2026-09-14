import { spawn } from "node:child_process";
import { chatInputSnapshot } from "../sessions/session-chat-input.js";
import { nativeInputQueue } from "./native-input-queue.js";

/** Output-only, size-neutral tmux control client. No keys, resize or terminal replay. */
export function watchNativeInput({ sessions, session }, changed) {
  let closed = false,
    timer,
    reading = false,
    dirty = false,
    digest;
  const publish = (value) => {
    const next = JSON.stringify(value);
    if (!closed && next !== digest) {
      digest = next;
      changed(value);
    }
  };
  const read = async () => {
    timer = null;
    if (closed) return;
    if (reading) {
      dirty = true;
      return;
    }
    reading = true;
    try {
      const current = await sessions.get(session.id);
      if (
        current.status !== "running" ||
        current.accountId !== session.accountId ||
        current.tool !== session.tool
      ) {
        publish(null);
        return;
      }
      const snapshot = await chatInputSnapshot(sessions, current);
      publish({
        generation: snapshot.observationGeneration,
        providerSessionId: snapshot.providerSessionId,
        queue: nativeInputQueue(current.tool, snapshot.raw, snapshot.pane),
      });
    } catch {
      publish(null);
    } finally {
      reading = false;
      if (dirty) {
        dirty = false;
        invalidate();
      }
    }
  };
  const invalidate = () => {
    if (closed || timer) return;
    timer = setTimeout(read, 200);
    timer.unref();
  };
  const child = spawn(
    sessions.tmuxPath,
    [
      "-u",
      "-S",
      sessions.socketPath,
      "-f",
      sessions.configPath,
      "-C",
      "attach-session",
      "-f",
      // tmux uses the latest client for external paste-buffer commands: read-only
      // here would also block normal Chat input. This client never writes stdin.
      "ignore-size",
      "-t",
      sessions.target(session.id),
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  child.stdin.on("error", () => {});
  // Data are only invalidation hints; no terminal output is stored or exposed.
  child.stdout.on("data", invalidate);
  child.on("error", () => publish(null));
  child.on("exit", () => {
    publish(null);
    closed = true;
    clearTimeout(timer);
  });
  invalidate();
  return () => {
    closed = true;
    clearTimeout(timer);
    child.stdin.destroy();
    child.kill();
  };
}
