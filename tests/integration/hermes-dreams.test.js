import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { DreamingSettings } from "../../server/features/assistants/dreaming-settings.js";
import { HermesDreamStore } from "../../server/features/assistants/hermes-dream-store.js";
import {
  HermesDreams,
  dreamNight,
} from "../../server/features/assistants/hermes-dreams.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { attachHermesFleet } from "../../server/features/assistants/runtimes/runtime-for.js";
import { shellService } from "../helpers/assistant-shell-service.js";

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
const hourMs = 3600000;
// 03:00 in Berlin (UTC+1 in November) on 2026-11-08.
const night = new Date(Date.UTC(2026, 10, 8, 2));
const before = (ms) => new Date(night.getTime() - ms);
const model = { connectionId: "c", modelId: "m" };
const memoryOn = { capabilities: { memory: true, reminders: false } };

// One scripted Hermes process set: its two memory files behind the files port's hash
// check, its transcripts by session key, and a one-shot answering `reply(request)`.
// `onAsk(n)` runs at the n-th model call, before it answers (a chat write meanwhile).
function hermesSet() {
  const set = {
    ready: true,
    files: { "MEMORY.md": "Lives in Berlin", "USER.md": null },
    transcripts: {},
    asks: [],
    onAsk: () => {},
    reply: () =>
      JSON.stringify({
        "MEMORY.md": [{ keep: "M1" }, { text: "Likes green tea" }],
        "USER.md": [],
        summary: "Added the tea.",
      }),
  };
  set.runtime = {
    host: { ready: () => set.ready },
    agentFiles: {
      async get({ name }) {
        const content = set.files[name];
        return {
          file:
            content === null
              ? { name, missing: true }
              : { name, content, hash: sha(content) },
        };
      },
      async set({ name, content, expectedHash, expectedMissing }) {
        const current = set.files[name];
        const same = expectedMissing
          ? current === null
          : current !== null && sha(current) === expectedHash;
        if (!same) throw Object.assign(new Error("changed"), { code: "CONFLICT" });
        set.files[name] = content;
        return { file: { name, content, hash: sha(content) } };
      },
    },
    sessions: {
      async history({ sessionKey, limit, offset = 0 }) {
        const rows = set.transcripts[sessionKey] ?? [];
        const end = rows.length - offset;
        const start = Math.max(0, end - limit);
        return { messages: rows.slice(start, Math.max(0, end)), hasMore: start > 0 };
      },
      async reviewMemory(request) {
        set.asks.push(request);
        set.onAsk(set.asks.length);
        return { text: set.reply(request) };
      },
    },
  };
  return set;
}

function fixture(t, { enabled = true, hour = 3, timeZone = "Europe/Berlin" } = {}) {
  const f = shellService(t, []);
  f.runtime.paths = runtimePaths(f.dataDir);
  fs.mkdirSync(f.runtime.paths.root, { recursive: true });
  const sets = new Map();
  attachHermesFleet(f.runtime, {
    available: () => true,
    runtimeOf: (agent) => sets.get(agent.runtimeAgentId)?.runtime,
    close: async () => {},
  });
  const prepared = [];
  f.config.apply = async (id) => prepared.push(id);
  const settings = new DreamingSettings({ dataDir: f.dataDir });
  t.after(() => settings.close());
  settings.save({ enabled, hour, timeZone }, settings.get().revision);
  const store = new HermesDreamStore(settings.db);
  const dreams = new HermesDreams({ settings, assistants: f.service, store });
  const changes = [];
  dreams.onChange = (id) => changes.push(id);
  // A Hermes agent with memory unless `memory: false`, and its scripted set.
  const agent = (name, { memory = true, runtime = "hermes" } = {}) => {
    const created = f.store.createAssistant({ name, instructions: "", model, runtime });
    const saved = memory
      ? f.store.updateAssistant(created.id, memoryOn, created.revision)
      : created;
    const set = hermesSet();
    sets.set(saved.runtimeAgentId, set);
    return { ...saved, set };
  };
  // A chat of `agent` with transcript rows `[role, text, at]`, last active at the last.
  const chat = (agent, rows, extra = {}) => {
    const conversation = f.store.saveConversation({
      assistantId: agent.id,
      runtimeSessionKey: `agent:${agent.runtimeAgentId}:hermes:${crypto.randomUUID()}`,
    });
    const at = Math.max(...rows.map((r) => r[2].getTime()));
    f.store.updateConversation(conversation.id, {
      lastActivityAt: new Date(at).toISOString(),
      ...extra,
    });
    agent.set.transcripts[conversation.runtimeSessionKey] = rows.map(
      ([role, text, when], i) => ({
        role,
        text,
        entry: {
          id: `row:${i}`,
          role,
          text,
          timestamp: when.getTime(),
          runId: null,
          turnKey: null,
          internal: false,
          compaction: null,
        },
      }),
    );
    return conversation;
  };
  return { ...f, sets, settings, store, dreams, changes, prepared, agent, chat };
}

const day = [
  ["user", "I drink green tea every morning", before(10 * hourMs)],
  ["assistant", "Noted, green tea it is", before(9 * hourMs)],
];

test("a Hermes agent with memory dreams once at the hour", async (t) => {
  const f = fixture(t);
  const heron = f.agent("Heron");
  f.chat(heron, day);
  assert.deepEqual(
    f.dreams.due(night).map((a) => a.id),
    [heron.id],
  );
  const [entry] = await f.dreams.tick(night);
  assert.deepEqual(await f.dreams.tick(new Date(night.getTime() + 30 * 60000)), []);
  assert.equal(heron.set.asks.length, 1);
  assert.equal(heron.set.asks[0].agentId, heron.runtimeAgentId);
  assert.match(heron.set.asks[0].input, /I drink green tea every morning/);
  assert.match(heron.set.asks[0].input, /agent: Noted, green tea it is/);
  assert.equal(heron.set.files["MEMORY.md"], "Lives in Berlin\n§\nLikes green tea");
  assert.deepEqual(f.prepared, [heron.id]);
  assert.deepEqual(entry, {
    at: night.toISOString(),
    night: "2026-11-08",
    outcome: "applied",
    reason: null,
    file: null,
    counts: {
      "MEMORY.md": { kept: 1, added: 1, merged: 0, replaced: 0, dropped: 0 },
      "USER.md": { kept: 0, added: 0, merged: 0, replaced: 0, dropped: 0 },
    },
    chars: { "MEMORY.md": 33, "USER.md": 0 },
    summary: "Added the tea.",
  });
  assert.deepEqual(f.store.diary(heron.id).entries, [entry]);
  assert.equal(f.store.cursor(heron.id), day[1][2].getTime());
  assert.equal(f.store.night(heron.id), "2026-11-08");
  assert.deepEqual(f.changes, [heron.id]);
  // The night's start state was backed up first.
  const folder = `${f.runtime.paths.root}/memory-backups/${heron.runtimeAgentId}`;
  assert.deepEqual(fs.readdirSync(folder), ["MEMORY-20261108T020000000Z.md"]);
  assert.equal(
    fs.readFileSync(`${folder}/MEMORY-20261108T020000000Z.md`, "utf8"),
    "Lives in Berlin",
  );
});

test("archived agents, agents without memory and OpenClaw agents do not dream", async (t) => {
  const f = fixture(t);
  const heron = f.agent("Heron");
  f.agent("Forgetful", { memory: false });
  f.agent("Orchid", { runtime: "openclaw" });
  // Stored marks, as an archive, a deletion and a user's own agent leave them.
  const mark = (agent, fields) => {
    const body = { ...f.service.store.storedAssistant(agent.id), ...fields };
    f.service.store.db
      .prepare("UPDATE assistants SET body=? WHERE id=?")
      .run(JSON.stringify(body), agent.id);
  };
  const archived = f.agent("Archived");
  mark(archived, { archivedAt: new Date().toISOString() });
  const deleting = f.agent("Leaving");
  mark(deleting, { deletingAt: new Date().toISOString() });
  const waiting = f.agent("Waiting");
  waiting.set.ready = false;
  // A user's own agent and a temporary member of Heron dream as well.
  const own = f.agent("Own");
  mark(own, { userAccess: { mode: "own", members: [] } });
  const member = f.service.store.reserveMember({
    id: "member-t",
    parent: heron.id,
    assignment: { name: "T" },
    snapshot: { model, instructions: "" },
    teamId: "team",
    lifetime: "temporary",
  });
  // A member runs on its own set, on its lead's runtime.
  f.sets.set(member.runtimeAgentId, hermesSet());
  assert.deepEqual(
    f.dreams
      .due(night)
      .map((a) => a.name)
      .sort(),
    ["Heron", "Own", "T"],
  );
  // The agent whose host is not ready yet stays due for a later minute.
  await f.dreams.tick(night);
  waiting.set.ready = true;
  assert.deepEqual(
    f.dreams.due(new Date(night.getTime() + 60000)).map((a) => a.name),
    ["Waiting"],
  );
});

test("dreaming off dreams nothing", async (t) => {
  const f = fixture(t, { enabled: false });
  const heron = f.agent("Heron");
  f.chat(heron, day);
  assert.deepEqual(f.dreams.due(night), []);
  assert.deepEqual(await f.dreams.tick(night), []);
  assert.equal(heron.set.asks.length, 0);
  assert.equal(f.store.night(heron.id), null);
});

test("the dream runs once on a DST night and catches up within six hours", async (t) => {
  // Berlin springs forward from 02:00 to 03:00 on 2027-03-28: hour 2 is 03:00 CEST.
  const f = fixture(t, { hour: 2 });
  const heron = f.agent("Heron");
  const jump = new Date(Date.UTC(2027, 2, 28, 1));
  f.chat(heron, [["user", "I moved to Hamburg", new Date(jump.getTime() - 5 * hourMs)]]);
  assert.equal(
    dreamNight(new Date(jump.getTime() - 60000), { hour: 2, timeZone: "Europe/Berlin" }),
    null,
  );
  assert.equal(dreamNight(jump, { hour: 2, timeZone: "Europe/Berlin" }), "2027-03-28");
  assert.equal((await f.dreams.tick(jump)).length, 1);
  // 04:00 CEST: the same night, already dreamed.
  assert.deepEqual(await f.dreams.tick(new Date(jump.getTime() + hourMs)), []);
  assert.equal(heron.set.asks.length, 1);
  // Hour 3 on 2027-03-29 (CEST): 08:59 is within the six hours, 09:01 the next day not.
  const late = { hour: 3, timeZone: "Europe/Berlin" };
  assert.equal(dreamNight(new Date(Date.UTC(2027, 2, 29, 6, 59)), late), "2027-03-29");
  assert.equal(dreamNight(new Date(Date.UTC(2027, 2, 30, 7, 1)), late), null);
  f.settings.save({ enabled: true, ...late }, f.settings.get().revision);
  assert.deepEqual(
    f.dreams.due(new Date(Date.UTC(2027, 2, 29, 6, 59))).map((a) => a.id),
    [heron.id],
  );
  assert.deepEqual(f.dreams.due(new Date(Date.UTC(2027, 2, 30, 7, 1))), []);
  // Across midnight: hour 22 is still the night before at 03:59 and not at 04:01.
  const evening = { hour: 22, timeZone: "UTC" };
  assert.equal(dreamNight(new Date(Date.UTC(2027, 2, 30, 3, 59)), evening), "2027-03-29");
  assert.equal(dreamNight(new Date(Date.UTC(2027, 2, 30, 4, 1)), evening), null);
});

test("a chat write during the dream reruns once, then postpones", async (t) => {
  const f = fixture(t);
  const heron = f.agent("Heron");
  f.chat(heron, day);
  f.store.applied(heron.id, before(20 * hourMs).getTime());
  // The agent writes MEMORY.md in a chat while each model call thinks.
  heron.set.onAsk = (n) =>
    (heron.set.files["MEMORY.md"] = `Lives in Berlin\n§\nWrite ${n}`);
  const [entry] = await f.dreams.tick(night);
  assert.equal(heron.set.asks.length, 2);
  assert.match(heron.set.asks[1].input, /Write 1/);
  assert.equal(entry.outcome, "postponed");
  assert.equal(entry.reason, "changed");
  assert.equal(entry.file, "MEMORY.md");
  assert.equal(heron.set.files["MEMORY.md"], "Lives in Berlin\n§\nWrite 2");
  assert.equal(f.store.cursor(heron.id), before(20 * hourMs).getTime());
  assert.deepEqual(f.store.diary(heron.id).entries, [entry]);

  // One conflict, then a clean run: applied over the agent's write.
  const g = fixture(t);
  const finch = g.agent("Finch");
  g.chat(finch, day);
  finch.set.onAsk = (n) => {
    if (n === 1) finch.set.files["MEMORY.md"] = "Lives in Berlin\n§\nWrite 1";
  };
  // The second call sees the agent's write as M2 and keeps it.
  finch.set.reply = ({ input }) =>
    JSON.stringify({
      "MEMORY.md": [
        { keep: "M1" },
        ...(input.includes("Write 1") ? [{ keep: "M2" }] : []),
        { text: "Likes green tea" },
      ],
      "USER.md": [],
      summary: "Added the tea.",
    });
  const [applied] = await g.dreams.tick(night);
  assert.equal(finch.set.asks.length, 2);
  assert.equal(applied.outcome, "applied");
  assert.equal(
    finch.set.files["MEMORY.md"],
    "Lives in Berlin\n§\nWrite 1\n§\nLikes green tea",
  );
  assert.equal(g.store.cursor(finch.id), day[1][2].getTime());
});

test("a discarded night leaves the cursor", async (t) => {
  const f = fixture(t);
  const heron = f.agent("Heron");
  heron.set.files["MEMORY.md"] = "📌 Call me Sam";
  f.chat(heron, day);
  const cursor = before(20 * hourMs).getTime();
  f.store.applied(heron.id, cursor);
  heron.set.reply = () =>
    JSON.stringify({
      "MEMORY.md": [{ text: "Likes green tea" }],
      "USER.md": [],
      summary: "Dropped the name.",
    });
  const [entry] = await f.dreams.tick(night);
  assert.equal(entry.outcome, "discarded");
  assert.equal(entry.reason, "pinLost");
  assert.equal(entry.file, "MEMORY.md");
  assert.equal(heron.set.files["MEMORY.md"], "📌 Call me Sam");
  assert.equal(f.store.cursor(heron.id), cursor);
  assert.deepEqual(f.changes, [heron.id]);
  // The next night reads the same chats again.
  const next = new Date(night.getTime() + 24 * hourMs);
  await f.dreams.tick(next);
  assert.equal(heron.set.asks.length, 2);
  assert.match(heron.set.asks[1].input, /I drink green tea every morning/);
});

test("a night without new chats asks nothing and writes no diary entry", async (t) => {
  const f = fixture(t);
  const heron = f.agent("Heron");
  f.chat(heron, day);
  f.store.applied(heron.id, day[1][2].getTime());
  assert.deepEqual(await f.dreams.tick(night), []);
  assert.equal(heron.set.asks.length, 0);
  assert.deepEqual(f.prepared, []);
  assert.equal(f.store.night(heron.id), "2026-11-08");
  assert.deepEqual(f.store.diary(heron.id).entries, []);
  assert.deepEqual(f.changes, []);
  assert.deepEqual(f.dreams.due(night), []);
});

test("a first night reads the last 24 hours", async (t) => {
  const f = fixture(t);
  const heron = f.agent("Heron");
  f.chat(heron, [
    ["user", "An old remark", before(25 * hourMs)],
    ["user", "A fresh remark", before(23 * hourMs)],
  ]);
  heron.set.reply = () => "not json";
  const [entry] = await f.dreams.tick(night);
  assert.equal(entry.outcome, "failed");
  assert.equal(entry.reason, "unreadable");
  assert.match(heron.set.asks[0].input, /A fresh remark/);
  assert.doesNotMatch(heron.set.asks[0].input, /An old remark/);
  // A first night that applied nothing keeps where it began, so the next night reads
  // the same chats again rather than only its own 24 hours.
  assert.equal(f.store.cursor(heron.id), before(24 * hourMs).getTime());
  heron.set.reply = hermesSet().reply;
  const [next] = await f.dreams.tick(new Date(night.getTime() + 24 * hourMs));
  assert.equal(next.outcome, "applied");
  assert.match(heron.set.asks.at(-1).input, /A fresh remark/);
});

test("a busy agent still dreams", async (t) => {
  const f = fixture(t);
  const heron = f.agent("Heron");
  const conversation = f.chat(heron, day);
  const request = f.service.ledger.accept(conversation.id, {
    clientRequestId: crypto.randomUUID(),
    text: "Working",
  });
  f.service.ledger.recordAttempt(request.id);
  const [entry] = await f.dreams.tick(night);
  assert.equal(entry.outcome, "applied");
  assert.equal(heron.set.asks.length, 1);
});

test("a deleted chat is no longer read", async (t) => {
  const f = fixture(t);
  const heron = f.agent("Heron");
  f.chat(heron, day);
  f.chat(heron, [["user", "Forget this secret plan", before(8 * hourMs)]], {
    deletedAt: before(hourMs).toISOString(),
  });
  await f.dreams.tick(night);
  assert.equal(heron.set.asks.length, 1);
  assert.match(heron.set.asks[0].input, /green tea/);
  assert.doesNotMatch(heron.set.asks[0].input, /secret plan/);
});
