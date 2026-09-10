import fs from "node:fs";
import path from "node:path";

/** Observe native storage writes without attaching a TUI or reading conversations. */
export function watchChatSources({ session, accounts, dataDir, home }, changed) {
  const watchers = [];
  const env = accounts.environment(session.accountId);
  const add = (directory, accepts, recursive = false) => {
    try {
      const watcher = fs.watch(directory, { recursive }, (_event, filename) => {
        if (!filename || accepts(String(filename))) changed();
      });
      watcher.on("error", () => changed());
      watcher.unref();
      watchers.push(watcher);
    } catch {
      // Missing startup directories are reconciled by the shared recovery timer.
    }
  };
  const forSession = (name) => path.basename(name).startsWith(session.id + ".");
  add(path.join(dataDir, "native-sessions"), forSession);
  add(path.join(dataDir, "sessions"), forSession);
  if (session.tool === "codex") {
    const root = env.CODEX_HOME || path.join(env.HOME || home, ".codex");
    add(
      root,
      (name) => /^(sessions|archived_sessions|thread-writer-locks)[/\\]/.test(name),
      true,
    );
  } else if (session.tool === "claude") {
    const root = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || home, ".claude");
    add(root, (name) => name.startsWith("projects/") && name.endsWith(".jsonl"), true);
  } else if (session.tool === "opencode") {
    const root = env.XDG_DATA_HOME || path.join(env.HOME || home, ".local/share");
    add(
      root,
      (name) => name.startsWith("opencode/") && /(?:\.db(?:-wal)?|\.json)$/.test(name),
      true,
    );
  }
  return () => watchers.forEach((watcher) => watcher.close());
}
