import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { problem } from "../lib/storage.js";
import { providerId } from "../features/chat/provider-history.js";

const fail = (message) => problem(message, 409);
const missing = (error) => error.code === "ENOENT";

function relativeTo(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw fail("Unsafe conversation history path.");
  return relative;
}

// Reject links below the account root, including links in destination parents.
async function checked(root, relative, create = false) {
  const parts = relativeTo(root, path.resolve(root, relative)).split(path.sep);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (!missing(error)) throw error;
      if (create && index < parts.length - 1) {
        await fs.mkdir(current, { mode: 0o700 });
        stat = await fs.lstat(current);
      } else continue;
    }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1))
      throw fail("Unsafe symbolic or hard link in conversation history.");
    if (index < parts.length - 1 && !stat.isDirectory())
      throw fail("Unsafe conversation history directory.");
  }
  return current;
}

async function collect(root, relative, files, optional = false) {
  const file = await checked(root, relative);
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (optional && missing(error)) return;
    throw error;
  }
  if (stat.isDirectory()) {
    for (const name of await fs.readdir(file))
      await collect(root, path.join(relative, name), files);
  } else if (stat.isFile()) {
    if (files.length >= 5000 || stat.size > 256 * 1024 * 1024)
      throw fail("Conversation history is too large to transfer.");
    files.push(relative);
  } else throw fail("Unsafe conversation history file.");
}

export function canSwitchAccount(session) {
  return (
    ["codex", "claude"].includes(session.tool) &&
    !session.purpose &&
    !session.pipeline &&
    !session.imported?.historyOnly &&
    !session.provider &&
    !session.access?.providerConnectionId
  );
}

export function accountSwitchTargets(services, session) {
  if (!canSwitchAccount(session)) return [];
  return (services.accounts?.list() || [])
    .filter(
      (account) =>
        account.tool === session.tool &&
        account.id !== session.accountId &&
        !account.provider &&
        !account.internal,
    )
    .map(({ id, name }) => ({ id, name }));
}

/** Preflight reads only. Commit snapshots after the original writer has stopped. */
export async function prepareAccountTransfer(
  { accounts, history },
  session,
  account,
  id,
) {
  providerId(id);
  const key = session.tool === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
  const home = (env) =>
    env[key] || path.join(env.HOME, session.tool === "codex" ? ".codex" : ".claude");
  const source = await fs.realpath(home(accounts.environment(session.accountId)));
  const targetPath = home(accounts.environment(account.id));
  // AccountStore creates managed roots; a local CLI may not have run yet.
  await fs.mkdir(targetPath, { recursive: true, mode: 0o700 });
  const target = await fs.realpath(targetPath);
  if (source === target) throw fail("The accounts share the same CLI storage.");
  let file;
  let historyMode;
  if (session.tool === "claude") file = await history.claudeFile(session, id);
  else {
    const client = history.codex(session);
    const { thread } = await client.request("thread/read", {
      threadId: id,
      includeTurns: false,
    });
    if (thread?.id !== id || thread?.cwd !== session.cwd || !thread.path)
      throw fail("Native conversation history cannot be transferred.");
    historyMode = thread.historyMode || "legacy";
    if (!["legacy", "paginated"].includes(historyMode))
      throw fail(
        "This Codex history storage format does not expose a portable conversation. The account was not changed.",
      );
    if (historyMode === "legacy") {
      const full = await client.request("thread/read", {
        threadId: id,
        includeTurns: true,
      });
      if (
        full.thread?.id !== id ||
        full.thread?.cwd !== session.cwd ||
        full.thread?.path !== thread.path ||
        (full.thread?.historyMode || "legacy") !== historyMode
      )
        throw fail("Conversation history changed during transfer preparation.");
    }
    file = thread.path;
  }
  const relative = relativeTo(source, file);
  if (
    session.tool === "codex"
      ? !/^(sessions|archived_sessions)\//.test(relative) ||
        !path.basename(file).endsWith(`-${id}.jsonl`)
      : !relative.startsWith(`projects${path.sep}`) ||
        path.basename(file) !== `${id}.jsonl`
  )
    throw fail("Unsafe conversation history path.");
  const destination = (entry) =>
    session.tool === "codex" ? entry.replace(/^archived_sessions\//, "sessions/") : entry;
  async function snapshot() {
    const files = [];
    await collect(source, relative, files);
    if (session.tool === "claude") {
      await collect(source, relative.slice(0, -6), files, true);
      await collect(source, path.join("file-history", id), files, true);
    }
    let bytes = 0;
    const entries = [];
    for (const entry of files) {
      const data = await fs.readFile(await checked(source, entry));
      bytes += data.length;
      if (bytes > 256 * 1024 * 1024)
        throw fail("Conversation history is too large to transfer.");
      const output = await checked(target, destination(entry));
      let previous;
      try {
        previous = await fs.readFile(output);
      } catch (error) {
        if (!missing(error)) throw error;
      }
      if (previous && !data.subarray(0, previous.length).equals(previous))
        throw fail("The target account contains different conversation history.");
      entries.push({ entry: destination(entry), data, previous });
    }
    const lines = entries[0].data.toString("utf8").trim().split("\n");
    let records;
    try {
      records = lines.map((line) => JSON.parse(line));
    } catch {
      throw fail("Conversation history is incomplete. Try again when the CLI is idle.");
    }
    const meta =
      session.tool === "codex"
        ? records.find((record) => record.type === "session_meta")?.payload
        : records.find((record) => record.sessionId && record.cwd && !record.isSidechain);
    if ((meta?.id || meta?.sessionId) !== id || meta.cwd !== session.cwd)
      throw fail("Conversation history identity does not match this session.");
    if (session.tool === "codex") {
      // Paginated history is still a native rollout. Codex rebuilds its SQLite
      // projection on resume; copying an account database would leak other threads.
      // Its ordinal sequence must be complete, both at preflight and after stop.
      if (
        (meta.history_mode || "legacy") !== historyMode ||
        (historyMode === "paginated" &&
          records.some((record, index) => record.ordinal !== index))
      )
        throw fail("Conversation history format is incomplete or not portable.");
    }
    return entries;
  }
  await snapshot();
  return {
    async commit() {
      const entries = await snapshot();
      for (const { entry, data, previous } of entries) {
        const output = await checked(target, entry, true);
        if (previous?.equals(data)) continue;
        const temp = output + `.agentpier-${randomUUID()}`;
        try {
          await fs.writeFile(temp, data, { flag: "wx", mode: 0o600 });
          // Recheck before replacing; a second native writer must not lose its data.
          let current;
          try {
            current = await fs.readFile(await checked(target, entry));
          } catch (error) {
            if (!missing(error)) throw error;
          }
          if (previous ? !current?.equals(previous) : current !== undefined)
            throw fail("The target conversation changed during transfer.");
          await fs.rename(temp, output);
        } finally {
          await fs.rm(temp, { force: true });
        }
      }
    },
  };
}
