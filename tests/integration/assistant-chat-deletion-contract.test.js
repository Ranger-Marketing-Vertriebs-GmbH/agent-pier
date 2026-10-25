import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantModels } from "../../server/features/assistants/assistant-models.js";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import {
  deleteNativeSession,
  deletedTranscripts,
  markArchivePurges,
} from "../../server/features/assistants/chat-removal.js";
import { deleteReleasedSessions } from "../../server/features/users/user-release.js";
import { createGatewaySession } from "../../server/features/assistants/session-create.js";

// A deleted chat's text is gone from the pinned runtime (AGENTPIER-220): after
// AgentPier's delete, no file the Gateway owns, no SQLite row (archive blobs
// decoded) and no WAL frame names the chat's marker any more.

// Answers every turn with the turn's own text, so the reply names the marker too.
async function echoModelServer() {
  const server = http.createServer(async (req, res) => {
    let bytes = "";
    for await (const part of req) bytes += part;
    if (req.method !== "POST" || !bytes) return res.writeHead(404).end();
    const input = JSON.parse(bytes);
    const last = input.messages.findLast((m) => m.role === "user");
    const said =
      typeof last?.content === "string"
        ? last.content
        : (last?.content || []).map((c) => c.text || "").join(" ");
    const word = said.match(/\bMARK[A-Z0-9]+\b/)?.[0] || "none";
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: "chat-deletion-contract",
          object: "chat.completion.chunk",
          model: input.model,
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    chunk({ content: `Noted ${word}` });
    chunk({}, "stop");
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

const decoded = (bytes) => {
  const views = [bytes];
  try {
    views.push(zlib.zstdDecompressSync(bytes));
  } catch {
    /* Not zstd. */
  }
  return views;
};

// Every SQLite row naming the marker, read through SQLite (WAL included), blobs decoded.
function sqliteHits(file, marker) {
  const hits = [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name);
    for (const table of tables) {
      const quoted = `"${table.replaceAll('"', '""')}"`;
      for (const row of db.prepare(`SELECT * FROM ${quoted}`).all())
        for (const [column, value] of Object.entries(row)) {
          const bytes =
            value instanceof Uint8Array
              ? Buffer.from(value)
              : Buffer.from(String(value ?? ""), "utf8");
          if (decoded(bytes).some((view) => view.includes(marker)))
            hits.push(`${path.basename(file)}:${table}.${column}`);
        }
    }
  } finally {
    db.close();
  }
  return hits;
}

const isSqlite = (file) => {
  try {
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    return head.toString("latin1") === "SQLite format 3\0";
  } catch {
    return false;
  }
};

// Where the marker is stored below root: in a file's bytes (zstd files decoded) and in
// a SQLite row (read through SQLite, WAL included, blobs decoded). A database's own
// bytes and its WAL are not read raw: free pages may keep a row OpenClaw deleted
// until SQLite reuses them, and they are reported apart (`residue`).
function markerHits(root, marker) {
  const hits = [];
  const residue = [];
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        const relative = path.relative(root, file);
        const raw = decoded(fs.readFileSync(file)).some((view) => view.includes(marker));
        const database = isSqlite(file) || /\.sqlite[^/]*-(wal|shm|journal)$/.test(file);
        if (raw) (database ? residue : hits).push(relative);
        if (isSqlite(file))
          hits.push(...sqliteHits(file, marker).map((hit) => `${relative} ${hit}`));
      }
    }
  };
  walk(root);
  return { hits, residue };
}

const installed = process.env.AGENTPIER_ASSISTANT_PROVIDER_RUNTIME;
test(
  "a deleted chat leaves no copy of its text in the pinned runtime",
  { skip: !installed, timeout: contractTimeout(240000) },
  async (t) => {
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(installed, "app/node_modules/openclaw/package.json"),
          "utf8",
        ),
      ).version,
      runtimeManifest.version,
    );
    // 2026.10.7 refuses some state below a symlinked temp folder (/var/folders on macOS).
    const dataDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "assistant-chat-deletion-"),
    );
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => ({
        version: runtimeManifest.version,
        nodePath: path.join(installed, "node/bin/node"),
        entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
      }),
    });
    const store = new AssistantStore({ dataDir });
    const server = await echoModelServer();
    t.after(async () => {
      try {
        await runtime.close();
        store.close();
        await server.close();
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
    const connections = new ProviderConnections({ dataDir });
    const models = new AssistantModels({ connections });
    await runtime.start();
    const config = new AssistantConfig({
      client: runtime.client,
      models,
      store,
      workspaces: runtime.paths.workspaces,
    });
    const c = connections.create({
      providerId: "endpoint",
      name: "echo",
      endpoint: {
        preset: "custom",
        openaiBaseUrl: `${server.origin}/v1`,
        authHeader: null,
        protocols: { messages: false, responses: false, chatCompletions: true },
        models: [
          {
            modelId: "echo-model",
            source: "manual",
            contextTokens: 32768,
            outputTokens: 4096,
          },
        ],
      },
    });
    const a = store.createAssistant({
      name: "Deletion",
      instructions: "Reply briefly.",
      model: { connectionId: c.id, modelId: "echo-model" },
    });
    await config.apply(a.id);
    const client = runtime.client;
    const turn = async (key, message) => {
      const sent = await client.call("sessions.send", {
        key,
        message,
        idempotencyKey: randomUUID(),
      });
      const result = await client.call(
        "agent.wait",
        { runId: sent.runId, timeoutMs: 45000 },
        { timeoutMs: 50000 },
      );
      assert.equal(result.status, "ok", JSON.stringify(result));
    };
    const mark = () => `MARK${randomUUID().replaceAll("-", "").toUpperCase()}`;
    const open = async (label) => {
      const created = await createGatewaySession(client, {
        agentId: a.runtimeAgentId,
        label: `AgentPier ${a.id} chat ${label}`,
      });
      return store.saveConversation({
        id: randomUUID(),
        assistantId: a.id,
        runtimeSessionKey: created.key,
      });
    };
    const found = (marker) => markerHits(runtime.paths.root, Buffer.from(marker));
    const agentDb = path.join(
      runtime.paths.state,
      "agents",
      a.runtimeAgentId,
      "agent",
      "openclaw-agent.sqlite",
    );
    const archiveRows = () => {
      const db = new DatabaseSync(agentDb, { readOnly: true });
      try {
        return db
          .prepare("SELECT session_key, reason FROM session_transcript_archives")
          .all()
          .map((row) => ({ ...row }));
      } finally {
        db.close();
      }
    };
    // AgentPier's own delete (chat-removal.js) against a minimal service.
    const assistants = {
      runtime: { client, paths: runtime.paths },
      store,
      ledger: { forgetTexts() {} },
    };

    // An empty chat on an agent that never archived: OpenClaw creates the archive
    // table on the delete, so a database without it means drift (ARCHIVE_SCHEMA).
    const blank = await open("blank");
    assert.equal(await deleteNativeSession(assistants, blank), true);
    t.diagnostic(JSON.stringify({ blankArchives: archiveRows() }));

    const doomed = await open("doomed");
    const other = await open("other");
    const [early, late, kept] = [mark(), mark(), mark()];
    await turn(doomed.runtimeSessionKey, `Remember ${early} please`);
    // sessions.reset keeps the key and starts a fresh window; 2026.10.7 keeps the
    // earlier rows in the session itself and writes no reset archive for it.
    await client.call("sessions.reset", { key: doomed.runtimeSessionKey });
    await turn(doomed.runtimeSessionKey, `Remember ${late} please`);
    await turn(other.runtimeSessionKey, `Remember ${kept} please`);
    assert.deepEqual(archiveRows(), []);
    assert.ok(found(early).hits.length > 0);
    assert.ok(found(late).hits.length > 0);

    assert.equal(
      await deleteNativeSession(assistants, store.getConversation(doomed.id)),
      true,
    );
    for (const marker of [early, late]) {
      const { hits, residue } = found(marker);
      // Not a copy any reader serves: bytes of rows deleted without secure_delete,
      // and the archive's old pages in the WAL, until SQLite overwrites them.
      t.diagnostic(JSON.stringify({ residue }));
      assert.deepEqual(hits, []);
    }
    assert.equal(store.storedConversation(doomed.id).nativeDeletePending, false);

    // A chat deleted before this purge existed (its archive row stayed, its mark went)
    // is marked again once and purged by the next start's pass.
    const legacy = await open("legacy");
    const old = mark();
    await turn(legacy.runtimeSessionKey, `Remember ${old} please`);
    const sessionId = (
      await client.call("sessions.describe", { key: legacy.runtimeSessionKey })
    ).session.sessionId;
    const answer = await client.call("sessions.delete", {
      key: legacy.runtimeSessionKey,
      deleteTranscript: true,
    });
    for (const file of deletedTranscripts(
      runtime.paths.state,
      a.runtimeAgentId,
      sessionId,
    ))
      fs.rmSync(file);
    store.updateConversation(legacy.id, {
      deletedAt: new Date().toISOString(),
      nativeDeletePending: false,
    });
    assert.equal(answer.deleted, true);
    assert.ok(
      found(old).hits.some((hit) =>
        hit.endsWith("session_transcript_archives.archive_blob"),
      ),
    );
    // Deleting the missing session again answers ok, without deleting anything.
    const again = await client.call("sessions.delete", {
      key: legacy.runtimeSessionKey,
      deleteTranscript: true,
    });
    t.diagnostic(JSON.stringify({ again }));
    // Nor does it describe it: a chat deleted before AgentPier recorded the session id
    // is purged by its session key alone.
    assert.equal(
      (await client.call("sessions.describe", { key: legacy.runtimeSessionKey })).session,
      null,
    );
    assert.equal(again.deleted, false);
    assert.ok(markArchivePurges(store) >= 1);
    assert.equal(markArchivePurges(store), 0);
    await deleteReleasedSessions({ assistants });
    assert.deepEqual(found(old).hits, []);
    assert.equal(store.storedConversation(legacy.id).nativeDeletePending, false);

    // The other chat keeps its text, and the Gateway keeps serving it.
    assert.ok(found(kept).hits.length > 0);
    await turn(other.runtimeSessionKey, `Again ${kept}`);
    const history = await client.call("chat.history", {
      sessionKey: other.runtimeSessionKey,
      limit: 50,
    });
    assert.match(JSON.stringify(history.messages), new RegExp(kept));
  },
);
