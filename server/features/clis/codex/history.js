import fs from "node:fs/promises";
import path from "node:path";
import { serverMessages } from "../../../lib/i18n/de.js";
import { problem } from "../../../lib/storage.js";
import { inside, providerId, readJsonLines } from "../../chat/history-files.js";
import { normalizeCodex, normalizeCodexRecords } from "../../chat/history-parsers.js";
import { observeCodex } from "../../chat/codex-observability.js";
import { reconcileCodexTail } from "../../chat/codex-live-tail.js";
import { splitPage } from "../../chat/history-page-split.js";
import { discoverCodex } from "../../chat/slash-discovery-others.js";
import { configRoot, dataRoot } from "./profile.js";

// Codex history: threads read through the read-only app-server client
// (history-client.js), supplemented by the rollout files under CODEX_HOME.
// `history` is the ProviderHistory instance that owns the clients and caches.

export const normalize = normalizeCodex;
export const observe = observeCodex;

export async function readModels(history, session) {
  return history.codexRequest(session, async (client) => {
    const models = [],
      cursors = new Set();
    let cursor = null;
    do {
      const result = await client.request("model/list", {
        cursor,
        limit: 100,
        includeHidden: true,
      });
      if (!Array.isArray(result?.data) || models.length + result.data.length > 1000)
        throw problem(serverMessages.chat.codexVersionUnsupported, 409);
      for (const model of result.data)
        if (typeof model.model === "string" && typeof model.displayName === "string")
          models.push({ modelId: model.model, label: model.displayName });
      cursor = result.nextCursor;
      if (
        cursor &&
        (typeof cursor !== "string" || cursors.has(cursor) || cursors.size >= 9)
      )
        throw problem(serverMessages.chat.codexVersionUnsupported, 409);
      cursors.add(cursor);
    } while (cursor);
    return models;
  });
}

export async function list(history, session) {
  const result = await history.codexRequest(session, (client) =>
    client.request("thread/list", {
      cwd: session.cwd,
      limit: 100,
      sortKey: "updated_at",
      sourceKinds: ["cli", "appServer"],
    }),
  );
  return (result.data || [])
    .filter((t) => t.cwd === session.cwd)
    .map((t) => ({
      id: t.id,
      title: t.name || t.preview?.slice(0, 100) || `Codex · ${t.id.slice(0, 8)}`,
      updatedAt: new Date(t.updatedAt * 1000).toISOString(),
    }));
}

export async function read(history, session, id) {
  // Fetch metadata first: paginated stores cannot include turns in thread/read.
  const { thread } = await history.codexRequest(session, (client) =>
    client.request("thread/read", {
      threadId: id,
      includeTurns: false,
    }),
  );
  if (thread?.cwd !== session.cwd)
    throw problem(serverMessages.chat.historyProjectMismatch, 409);
  let full;
  try {
    full = (
      await history.codexRequest(session, (client) =>
        client.request("thread/read", {
          threadId: id,
          includeTurns: true,
        }),
      )
    ).thread;
  } catch (error) {
    if (error.status !== 409) throw error;
    const turns = [];
    let cursor;
    do {
      const page = await history.codexRequest(session, (client) =>
        client.request("thread/turns/list", {
          threadId: id,
          limit: 100,
          itemsView: "full",
          sortDirection: "desc",
          ...(cursor ? { cursor } : {}),
        }),
      );
      turns.push(...(page.data || []));
      cursor = page.nextCursor;
    } while (cursor);
    full = { ...thread, turns: turns.reverse() };
  }
  const result = { ...normalizeCodex(full), observability: observeCodex(full) };
  if (thread.path) {
    const env = history.environment(session),
      root = configRoot(env, env.HOME);
    try {
      const records = await readJsonLines(await inside(thread.path, root));
      const meta = records.find((r) => r?.type === "session_meta")?.payload;
      if (meta?.id === id && meta.cwd === session.cwd) {
        result.tasks = normalizeCodexRecords(records).tasks;
        result.observability = observeCodex(full, records);
      }
    } catch {
      /* Structured thread messages remain readable when legacy rollout storage is unavailable. */
    }
  }
  try {
    const children = await history.codexChildren.read(history, session, id);
    if (children)
      result.observability = { ...result.observability, subagentUsage: children };
  } catch {
    /* Child usage is supplemental. */
  }
  return result;
}

/** The latest turns, or null when the page comes from a full read instead. */
export async function readPage(history, session, id, state) {
  if (state?.remaining?.length || state?.legacy) return null;
  const { thread } = await history.codexRequest(session, (client) =>
    client.request("thread/read", { threadId: id, includeTurns: false }),
  );
  if (thread?.cwd !== session.cwd)
    throw problem(serverMessages.chat.historyProjectMismatch, 409);
  let page;
  try {
    page = await history.codexRequest(session, (client) =>
      client.request("thread/turns/list", {
        threadId: id,
        limit: 10,
        itemsView: "full",
        sortDirection: "desc",
        ...(state?.cursor ? { cursor: state.cursor } : {}),
      }),
    );
  } catch (error) {
    if (error.status !== 409 || state?.cursor) throw error;
    return null;
  }
  let full = { ...thread, turns: [...(page.data || [])].reverse() };
  if (!state) full = await reconcileCodexTail(history, session, full);
  const content = normalizeCodex(full);
  const childSources = [];
  const [records, children] = await Promise.all([
    !state && history.codexMetadata
      ? history.codexMetadata.read(history, session, full).catch(
          // API history remains available when supplemental metadata is unavailable.
          () => [],
        )
      : [],
    !state && history.codexChildren
      ? history.codexChildren.read(history, session, id, { sources: childSources }).catch(
          // Child usage is supplemental.
          () => null,
        )
      : null,
  ]);
  try {
    if (records.some((record) => record.payload?.name === "update_plan"))
      content.tasks = normalizeCodexRecords(records).tasks;
  } catch {
    /* Plans stay as reported by the API when metadata cannot be normalized. */
  }
  return {
    ...content,
    observability: {
      ...observeCodex(full, records),
      ...(children ? { subagentUsage: children } : {}),
      ...(full.tailUnavailable ? { stale: true } : {}),
    },
    ...splitPage(content.messages, page.nextCursor ? { cursor: page.nextCursor } : null),
    // The rollout the CLI appends to, for the chat's source probe.
    ...(!state && typeof thread.path === "string"
      ? { sources: [thread.path, ...childSources] }
      : {}),
  };
}

export async function readReloadContext(history, session, id) {
  providerId(id);
  const { thread } = await history.codexRequest(session, (client) =>
    client.request("thread/read", { threadId: id, includeTurns: false }),
  );
  if (
    thread?.id !== id ||
    thread?.cwd !== session.cwd ||
    !thread.path ||
    (await history.codexRolloutIdentity(session, thread.path)) !== id
  )
    throw problem(serverMessages.chat.historyProjectMismatch, 409);
  // Reload needs verified identity and the latest model, not all turn bodies.
  // The bounded metadata reader also works for rollouts larger than RPC limits.
  const records = await history.codexMetadata.read(history, session, thread);
  return {
    observability: {
      context: {
        modelId:
          records.find((record) => record.type === "turn_context")?.payload?.model ||
          null,
      },
    },
  };
}

export async function rolloutIdentity(history, session, file) {
  if (session.tool !== "codex") return null;
  const env = history.environment(session),
    root = configRoot(env, env.HOME);
  const verified = await inside(file, root);
  const handle = await fs.open(verified, "r");
  try {
    const buffer = Buffer.alloc(128 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end < 0) return null;
    const complete = text.slice(0, end);
    const records = complete.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const meta = records.find((record) => record?.type === "session_meta")?.payload;
    if (
      !meta?.id ||
      (typeof meta.source === "object" && meta.source?.subagent != null) ||
      (typeof meta.agent_path === "string" && meta.agent_path !== "/root") ||
      !meta.cwd ||
      (await fs.realpath(meta.cwd)) !== (await fs.realpath(session.cwd))
    )
      return null;
    return providerId(meta.id);
  } finally {
    await handle.close();
  }
}

/** Folders a chat without known sources watches for its rollout. */
export function watchRoots(env, home) {
  const root = dataRoot(env, home);
  return [path.join(root, "sessions"), path.join(root, "archived_sessions")];
}

export function slashCommands(scan, env, cwd) {
  return discoverCodex(scan, { root: configRoot(env, env.HOME), cwd });
}
