import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHermesClient } from "../../server/features/assistants/runtimes/hermes/hermes-connection.js";
import { hermesSessions } from "../../server/features/assistants/runtimes/hermes/hermes-sessions.js";
import { HermesRoutineDeliveries } from "../../server/features/assistants/runtimes/hermes/hermes-routines.js";
import {
  frozenSession,
  recapOf,
  sessionSuccessors,
} from "../../server/features/assistants/runtimes/hermes/hermes-session-successors.js";
import { sessionKeyOf } from "../../server/features/assistants/runtimes/hermes/hermes-run-state.js";
import { memoryTransport } from "../helpers/hermes-fake-gateway.js";
import { agentId, event } from "../helpers/hermes-scripted.js";

// Hermes freezes a session's model route and keys when it creates it, so a model,
// connection, advisor or key change never reached an existing chat (AGENTPIER-437,
// AGENTPIER-438). AgentPier creates following sessions, and moves a chat whose session
// an older AgentPier created to a following successor before its next turn.

// A gateway with stored sessions: `frozen` ones were created without
// follow_profile_config. Turns end at once with an echo row.
async function gateway({ frozen = [] } = {}) {
  const sessions = new Map();
  const add = (id, request) => sessions.set(id, { request, rows: [], archived: false });
  for (const id of frozen) add(id, { source: "cli", title: "Main chat" });
  const info = (id) => ({
    reasoning_effort: "",
    launch_request: sessions.get(id).request,
  });
  const snap = (id) => ({
    session_id: `live-${id}`,
    stored_session_id: id,
    revision: 0,
    execution_generation: 0,
    prompts: [],
    info: info(id),
  });
  const stored = (sid) => sid.replace(/^live-/, "");
  let created = 0;
  const { transport, peer } = memoryTransport();
  const client = createHermesClient(transport, { agentId, timeoutMs: 200 });
  const reply = (frame, result) => peer.send({ jsonrpc: "2.0", id: frame.id, result });
  peer.on("frame", (frame) => {
    const p = frame.params || {};
    switch (frame.method) {
      case "client.capabilities":
        return reply(frame, {});
      case "session.create": {
        const id = `s-${p.request_id}`;
        if (!sessions.has(id)) {
          created++;
          add(id, { ...p, request_id: undefined });
        }
        return reply(frame, snap(id));
      }
      case "session.resume":
        return reply(frame, snap(p.session_id));
      case "session.history": {
        const s = sessions.get(p.session_id);
        return s
          ? reply(frame, { messages: s.rows, count: s.rows.length })
          : peer.send({
              jsonrpc: "2.0",
              id: frame.id,
              error: { code: 4001, message: "not_found", data: { reason: "not_found" } },
            });
      }
      case "agentpier.note":
        sessions.get(p.session_id).rows.push({
          role: "user",
          text: p.text,
          display_kind: "internal_notification",
        });
        return reply(frame, { appended: true });
      case "prompt.submit": {
        const id = stored(p.session_id);
        sessions
          .get(id)
          .rows.push(
            { role: "user", text: p.text },
            { role: "assistant", text: `ECHO: ${p.text}` },
          );
        reply(frame, { admission_id: `ad-${p.submission_id}`, status: "queued" });
        peer.send(
          event(
            "message.start",
            p.session_id,
            {},
            { admission_id: `ad-${p.submission_id}` },
          ),
        );
        return peer.send(
          event(
            "message.complete",
            p.session_id,
            { status: "complete", text: `ECHO: ${p.text}` },
            { admission_id: `ad-${p.submission_id}` },
          ),
        );
      }
      case "session.mutate": {
        const id = stored(p.session_id);
        if (p.operation === "delete") sessions.delete(id);
        if (p.operation === "archive") sessions.get(id).archived = p.payload.archived;
        return reply(frame, { revision: 1 });
      }
      default:
        return reply(frame, {});
    }
  });
  peer.send(event("gateway.ready"));
  await client.connect({ timeoutMs: 1000 });
  return { client, peer, sessions, created: () => created };
}

const frames = (peer, method) => peer.frames.filter((f) => f.method === method);

test("a chat is created following the agent's config.yaml", async () => {
  const hermes = await gateway();
  const sessions = hermesSessions({ client: hermes.client, agentId });
  await sessions.create({ agentId, label: "Chat", idempotencyKey: "k1" });
  const [create] = frames(hermes.peer, "session.create");
  assert.equal(create.params.follow_profile_config, true);
  assert.equal(create.params.title, "Chat");
  // A following session never moves to a successor.
  const { key } = await sessions.create({ agentId, label: "Two", idempotencyKey: "k2" });
  await sessions.send({ key, turn: { message: "hi" }, idempotencyKey: "r1" });
  assert.equal(hermes.created(), 2);
});

test("a frozen chat moves to a following successor once, its history kept", async () => {
  const hermes = await gateway({ frozen: ["old"] });
  hermes.sessions
    .get("old")
    .rows.push(
      { role: "user", text: "Remember the code 4711." },
      { role: "assistant", text: "Noted: 4711." },
      { role: "user", text: "[Cron delivery: x]", display_kind: "internal_notification" },
    );
  const successors = sessionSuccessors();
  const sessions = hermesSessions({ client: hermes.client, agentId }, { successors });
  const key = sessionKeyOf(agentId, "old");
  await sessions.send({ key, turn: { message: "Which code?" }, idempotencyKey: "r1" });
  // The successor follows the profile and is created once per frozen session.
  const [create] = frames(hermes.peer, "session.create");
  assert.equal(create.params.follow_profile_config, true);
  assert.equal(create.params.request_id, "agentpier-successor-old");
  const next = "s-agentpier-successor-old";
  assert.deepEqual(successors.of("old"), ["old", next]);
  // It starts with the conversation so far as an internal note, then the turn.
  const rows = hermes.sessions.get(next).rows;
  assert.equal(rows[0].display_kind, "internal_notification");
  assert.match(rows[0].text, /Owner: Remember the code 4711\.\n\nYou: Noted: 4711\./);
  assert.doesNotMatch(rows[0].text, /Cron delivery/);
  assert.deepEqual(
    rows.slice(1).map((r) => r.text),
    ["Which code?", "ECHO: Which code?"],
  );
  assert.equal(hermes.sessions.get("old").rows.length, 3, "the old session is kept");
  // The key stays; its history is both sessions', the note hidden as internal.
  const history = await sessions.history({ sessionKey: key, limit: 20 });
  assert.deepEqual(
    history.messages.filter((m) => !m.entry.internal).map((m) => m.text),
    ["Remember the code 4711.", "Noted: 4711.", "Which code?", "ECHO: Which code?"],
  );
  assert.equal(history.sessionInfo.count, 6);
  // Later turns go to the successor without another move.
  await sessions.send({ key, turn: { message: "Again" }, idempotencyKey: "r2" });
  assert.equal(frames(hermes.peer, "session.create").length, 1);
  assert.deepEqual(
    frames(hermes.peer, "prompt.submit").map((f) => f.params.session_id),
    [`live-${next}`, `live-${next}`],
  );
  // Deleting the chat deletes every session it ran in.
  await sessions.delete({ key });
  assert.equal(hermes.sessions.has("old"), false);
  assert.equal(hermes.sessions.has(next), false);
  assert.deepEqual(successors.of("old"), ["old"]);
});

test("a successor whose note was not written gets it before its next turn", async () => {
  const hermes = await gateway({ frozen: ["old"] });
  hermes.sessions.get("old").rows.push({ role: "user", text: "Earlier words" });
  const successors = sessionSuccessors();
  // A restart came between the move and the note: the chain is recorded, no note.
  hermes.sessions.set("s-next", {
    request: { follow_profile_config: true },
    rows: [],
    archived: false,
  });
  successors.add("old", "s-next");
  const sessions = hermesSessions({ client: hermes.client, agentId }, { successors });
  const key = sessionKeyOf(agentId, "old");
  await sessions.send({ key, turn: { message: "Now" }, idempotencyKey: "r1" });
  assert.equal(frames(hermes.peer, "session.create").length, 0);
  assert.deepEqual(
    hermes.sessions.get("s-next").rows.map((r) => r.display_kind ?? r.text),
    ["internal_notification", "Now", "ECHO: Now"],
  );
  assert.equal(successors.noted("old"), true);
});

test("a routine's note goes to the session the chat runs in now", () => {
  const successors = sessionSuccessors();
  successors.add("old", "s-next");
  const deliveries = new HermesRoutineDeliveries({
    supervisor: { agentId },
    successors,
  });
  const job = {
    id: "j1",
    name: "Daily",
    agentpier: {
      delivery: { kind: "chat" },
      target: { kind: "chat", sessionKey: sessionKeyOf(agentId, "old") },
    },
  };
  const note = deliveries.noteOf(job, "Result");
  assert.equal(note?.session, "s-next");
});

test("only a session created without following is frozen", () => {
  const of = (request) => frozenSession({ info: { launch_request: request } });
  assert.equal(of({ source: "cli" }), true);
  assert.equal(of({ follow_profile_config: true }), false);
  // A launch that never reads the profile stays as chosen.
  assert.equal(of({ ignore_user_config: true }), false);
  assert.equal(of({ safe_mode: true }), false);
  // Nothing known: no move.
  assert.equal(frozenSession({}), false);
  assert.equal(frozenSession({ info: {} }), false);
});

test("the note keeps the newest of the conversation within its limit", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    text: `message ${i} ${"x".repeat(80)}`,
  }));
  const recap = recapOf(rows, 1000);
  assert.ok(recap.length <= 1000, recap.length);
  assert.match(recap, /message 39/);
  assert.doesNotMatch(recap, /message 0 /);
  assert.equal(recapOf([]), null);
  assert.equal(recapOf([{ role: "tool", text: "x" }]), null);
});

test("the successor chains survive a restart in the agent's home", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-successors-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "agentpier-session-successors.json");
  const first = sessionSuccessors(file);
  first.add("old", "new");
  first.markNoted("old");
  const again = sessionSuccessors(file);
  assert.deepEqual(again.of("old"), ["old", "new"]);
  assert.equal(again.current("old"), "new");
  assert.equal(again.noted("old"), true);
  assert.equal(again.current("other"), "other");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  again.forget("old");
  assert.deepEqual(sessionSuccessors(file).of("old"), ["old"]);
});
