import { serverMessages } from "../../../lib/i18n/de.js";
import { problem } from "../../../lib/storage.js";
import { providerId } from "../../chat/history-files.js";
import { normalizeOpenCode } from "../../chat/history-parsers.js";
import { observeOpenCode } from "../../chat/opencode-observability.js";
import { activeOpenCodeExport } from "../../chat/opencode-revert.js";
import {
  readOpenCodePage,
  readOpenCodeReloadContext,
} from "../../chat/opencode-history-page.js";
import { discoverOpenCode } from "../../chat/slash-discovery-others.js";
import { configRoot, dataRoot } from "./profile.js";

// OpenCode history: its SQLite database when readable, else `opencode export`.
// `history` is the ProviderHistory instance that runs and tracks the CLI calls.

export const normalize = normalizeOpenCode;
export const observe = observeOpenCode;

export async function list(history, session) {
  const result = await history.opencode(session, ["session", "list", "--format", "json"]);
  return (Array.isArray(result) ? result : result.sessions || [])
    .filter((s) => s.directory === session.cwd && !s.parentID)
    .map((s) => ({
      id: s.id,
      title: s.title || s.id,
      updatedAt: new Date(s.time?.updated || Date.now()).toISOString(),
    }));
}

export async function read(history, session, id) {
  const exported = activeOpenCodeExport(await history.opencode(session, ["export", id]));
  if (exported.info?.id !== id || exported.info?.directory !== session.cwd)
    throw problem(serverMessages.chat.historyProjectMismatch, 409);
  return { ...normalizeOpenCode(exported), observability: observeOpenCode(exported) };
}

/** The database page, or null when the page comes from a full read instead. */
export async function readPage(history, session, id, state) {
  if (state?.legacy) return null;
  return readOpenCodePage(history, session, id, state);
}

export async function readReloadContext(history, session, id) {
  providerId(id);
  history.environment(session);
  return (
    (await readOpenCodeReloadContext(history, session, id)) || history.read(session, id)
  );
}

/** Folders a chat without known sources watches for its database. */
export function watchRoots(env, home) {
  return [dataRoot(env, home)];
}

export function slashCommands(scan, env, cwd) {
  return discoverOpenCode(scan, { root: configRoot(env, env.HOME), cwd });
}
