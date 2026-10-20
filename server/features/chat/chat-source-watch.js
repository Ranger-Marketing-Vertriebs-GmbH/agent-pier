import fs from "node:fs";
import path from "node:path";
import { ChatSourceWatchPool } from "./chat-source-watch-pool.js";

/** Observe only this chat's sources; never recursively watch an entire profile. */
export function watchChatSources(
  {
    session,
    accounts,
    dataDir,
    home,
    sources = () => null,
    settleMs = 500,
    watch = fs.watch,
    pool = new ChatSourceWatchPool({ watch }),
  },
  changed,
) {
  const subscriptions = new Map();
  let closed = false;
  const env = accounts.environment(session.accountId);
  const forSession = (name) => path.basename(name).startsWith(session.id + ".");
  const always = () => true;
  const root =
    session.tool === "claude"
      ? env.CLAUDE_CONFIG_DIR || path.join(env.HOME || home, ".claude")
      : session.tool === "codex"
        ? env.CODEX_HOME || path.join(env.HOME || home, ".codex")
        : path.join(
            env.XDG_DATA_HOME || path.join(env.HOME || home, ".local/share"),
            "opencode",
          );
  const reconcile = async () => {
    if (closed) return;
    const targets = [
      {
        file: path.join(dataDir, "native-sessions"),
        directory: true,
        accepts: forSession,
      },
      { file: path.join(dataDir, "sessions"), directory: true, accepts: forSession },
    ];
    const state = sources();
    const files = Array.isArray(state?.paths) ? state.paths : [];
    for (const file of files) targets.push({ file, accepts: always });
    if (session.tool === "claude" && files.length) {
      // Background subagent usage can change while the main transcript is idle.
      const file = files[0];
      targets.push({
        file: path.join(path.dirname(file), path.basename(file, ".jsonl"), "subagents"),
        directory: true,
        recursive: true,
        accepts: (name) => /\.(jsonl|json)$/.test(name),
      });
    }
    if (!files.length) {
      // Only unresolved/legacy histories need discovery. The first history read
      // runs before this, so normal chat switches never arm recursive discovery.
      const directories =
        session.tool === "codex"
          ? [path.join(root, "sessions"), path.join(root, "archived_sessions")]
          : session.tool === "claude"
            ? [
                path.join(
                  root,
                  "projects",
                  (session.cwd || "").replace(/[^a-zA-Z0-9]/g, "-"),
                ),
              ]
            : [root];
      for (const file of directories)
        targets.push({ file, directory: true, recursive: true, accepts: always });
    }
    const wanted = new Set();
    for (const target of targets) {
      const key = JSON.stringify([target.file, !!target.directory, !!target.recursive]);
      wanted.add(key);
      if (!subscriptions.has(key))
        subscriptions.set(
          key,
          pool.subscribe(target, (filename) => {
            if (!closed && (!filename || target.accepts(filename))) changed();
          }),
        );
    }
    for (const [key, stop] of subscriptions)
      if (!wanted.has(key)) {
        stop();
        subscriptions.delete(key);
      }
    await Promise.all([...subscriptions.values()].map((stop) => stop.refresh()));
  };
  const settle = setTimeout(() => {
    if (!closed) changed();
  }, settleMs);
  settle.unref();
  const stop = () => {
    closed = true;
    clearTimeout(settle);
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
  };
  stop.refresh = reconcile;
  return stop;
}
