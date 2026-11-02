import fs from "node:fs/promises";
import path from "node:path";
import { serverMessages } from "../../../lib/i18n/de.js";
import { problem } from "../../../lib/storage.js";
import { inside, providerId, readJsonLines } from "../../chat/history-files.js";
import { normalizeClaude } from "../../chat/history-parsers.js";
import { observeClaude } from "../../chat/claude-observability.js";
import { readClaudePage } from "../../chat/claude-history-page.js";
import { readClaudeReloadContext } from "../../chat/claude-reload-context.js";
import { discoverClaude } from "../../chat/slash-discovery-claude.js";
import { configRoot, dataRoot } from "./profile.js";

// Claude Code's history: JSONL transcripts under <config>/projects/<cwd slug>/.
// `history` is the ProviderHistory instance that owns the shared state.

export const normalize = normalizeClaude;
export const observe = observeClaude;

const slug = (cwd) => (cwd || "").replace(/[^a-zA-Z0-9]/g, "-");

export async function directory(history, session) {
  const env = history.environment(session);
  const root = configRoot(env, history.home);
  const name = session.cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const projects = path.join(root, "projects");
  let directories = [path.join(projects, name)];
  if (name.length > 200) {
    const entries = await fs.readdir(projects, { withFileTypes: true }).catch(() => []);
    directories = entries
      .filter((e) => e.isDirectory() && e.name.startsWith(name.slice(0, 200)))
      .map((e) => path.join(projects, e.name));
  }
  return { root, directories };
}

export async function file(history, session, id) {
  providerId(id);
  const { root, directories } = await history.claudeDirectory(session);
  // Claude Code moves a transcript into the project directory of its new
  // working directory when it enters or leaves a worktree. The session keeps
  // its original cwd, so fall back to every project directory of the profile.
  // Readers still verify the transcript's own cwd and session id afterwards.
  const projects = path.join(root, "projects");
  const others = (await fs.readdir(projects, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .map((e) => path.join(projects, e.name))
    .filter((directory) => !directories.includes(directory));
  for (const directory of [...directories, ...others]) {
    const file = path.join(directory, id + ".jsonl");
    try {
      return await inside(file, root);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw problem(serverMessages.chat.sessionHistoryPending, 404);
}

export function matches(records, session, id) {
  const metadata = records.find((r) => r?.cwd && r.sessionId && !r.isSidechain);
  return metadata?.cwd === session.cwd && metadata.sessionId === id;
}

export async function list(history, session) {
  const { directories } = await history.claudeDirectory(session);
  const choices = [];
  for (const directory of directories) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-zA-Z0-9_-]+\.jsonl$/.test(entry.name)) continue;
      const id = entry.name.slice(0, -6);
      const file = await history.claudeFile(session, id);
      const handle = await fs.open(file, "r");
      let head;
      try {
        const buffer = Buffer.alloc(128 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        head = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
      const records = head.split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      if (!history.claudeMatches(records, session, id)) continue;
      const first = records.find(
        (r) => r?.type === "user" && typeof r.message?.content === "string" && !r.isMeta,
      )?.message.content;
      const info = await fs.stat(file);
      choices.push({
        id,
        title: first?.slice(0, 100) || `Claude · ${id.slice(0, 8)}`,
        updatedAt: info.mtime.toISOString(),
      });
    }
  }
  return choices.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100);
}

export async function read(history, session, id) {
  const file = await history.claudeFile(session, id);
  const records = await readJsonLines(file);
  if (!records.some((r) => r?.cwd && r.sessionId && !r.isSidechain))
    throw problem(serverMessages.chat.sessionHistoryBeingWritten, 404);
  if (!history.claudeMatches(records, session, id))
    throw problem(serverMessages.chat.sessionHistoryMismatch, 409);
  const observability = observeClaude(records);
  return {
    ...normalizeClaude(records),
    observability: {
      ...observability,
      subagentUsage: history.claudeUsage.peek(session, id, file),
    },
  };
}

/** The transcript page, or null when a legacy cursor pages over a full read. */
export async function readPage(history, session, id, state) {
  if (state?.legacy) return null;
  return readClaudePage(history, session, id, state);
}

export async function readReloadContext(history, session, id) {
  providerId(id);
  history.environment(session);
  // Reload needs identity and the latest model; a long session may outgrow
  // the chat history limit, so stream the transcript instead of loading it.
  return readClaudeReloadContext(await history.claudeFile(session, id), session, id);
}

/** Folders a chat without known sources watches for its transcript. */
export function watchRoots(env, home, cwd) {
  return [path.join(dataRoot(env, home), "projects", slug(cwd))];
}

export function slashCommands(scan, env, cwd) {
  return discoverClaude(scan, { root: configRoot(env, env.HOME), cwd });
}
