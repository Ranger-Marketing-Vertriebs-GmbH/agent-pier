import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dreamOnce } from "../../server/features/assistants/hermes-dream.js";

const agentId = "hermes-agent";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const conflict = () => Object.assign(Error("changed"), { code: "CONFLICT", status: 409 });

/**
 * The agentFiles port of one agent in memory, as hermes-files.js answers it: `set`
 * writes only over the expected hash or absence. `beforeSet(name)` runs before each
 * write's check, so a test can change a file meanwhile.
 */
function filesPort(initial, { beforeSet = () => {} } = {}) {
  const store = { ...initial };
  const log = [];
  const fileOf = (name) =>
    store[name] === undefined
      ? { name, missing: true, content: "", hash: null }
      : { name, missing: false, content: store[name], hash: sha256(store[name]) };
  return {
    store,
    log,
    async get({ agentId: id, name }) {
      assert.equal(id, agentId);
      log.push(["get", name]);
      return { file: fileOf(name) };
    },
    async set({ agentId: id, name, content, expectedHash, expectedMissing }) {
      assert.equal(id, agentId);
      log.push(["set", name, { content, expectedHash, expectedMissing }]);
      beforeSet(name, store);
      const now = store[name];
      if (
        (expectedMissing === true && now !== undefined) ||
        (expectedHash !== undefined &&
          (now === undefined || sha256(now) !== expectedHash))
      )
        throw conflict();
      store[name] = content;
      return { ok: true, file: fileOf(name) };
    },
  };
}

/** sessions whose reviewMemory answers the scripted replies in turn. */
function sessionsPort(...replies) {
  const calls = [];
  return {
    calls,
    async reviewMemory(request) {
      calls.push(request);
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (reply instanceof Error) throw reply;
      return { text: typeof reply === "string" ? reply : JSON.stringify(reply) };
    },
  };
}

const start = {
  "MEMORY.md": "📌 Vault is /srv/quartz\n§\nLikes tea\n§\nLikes green tea",
  "USER.md": "Name is Ada",
};
const merged = {
  "MEMORY.md": [{ keep: "M1" }, { text: "Likes green tea", from: ["M2", "M3"] }],
  "USER.md": [{ text: "Name is Ada Lovelace", from: ["U1"] }],
  summary: "Merged tea.",
};
const sets = (files) => files.log.filter(([op]) => op === "set");

test("an applied night writes both files over the hashes it read and backs them up first", async () => {
  const files = filesPort(start);
  const sessions = sessionsPort(merged);
  const backups = [];
  const phases = [];
  const outcome = await dreamOnce({
    files,
    sessions,
    agentId,
    chats: [{ channel: "web", messages: [{ role: "person", text: "hi", at: 1 }] }],
    admit: async (fn) => {
      phases.push("admit");
      return fn();
    },
    backup: (contents) => backups.push({ contents, setsBefore: sets(files).length }),
  });
  assert.deepEqual(backups, [
    {
      contents: { "MEMORY.md": start["MEMORY.md"], "USER.md": start["USER.md"] },
      setsBefore: 0,
    },
  ]);
  assert.deepEqual(phases, ["admit", "admit"]);
  assert.equal(sessions.calls.length, 1);
  assert.equal(sessions.calls[0].maxTokens, 8000);
  assert.equal(sessions.calls[0].agentId, agentId);
  assert.match(sessions.calls[0].input, /\[M1\]/);
  assert.deepEqual(
    sets(files).map(([, name, { expectedHash, expectedMissing }]) => [
      name,
      expectedHash,
      expectedMissing,
    ]),
    [
      ["MEMORY.md", sha256(start["MEMORY.md"]), undefined],
      ["USER.md", sha256(start["USER.md"]), undefined],
    ],
  );
  assert.equal(files.store["MEMORY.md"], "📌 Vault is /srv/quartz\n§\nLikes green tea");
  assert.equal(files.store["USER.md"], "Name is Ada Lovelace");
  assert.equal(outcome.outcome, "applied");
  assert.equal(outcome.reason, null);
  assert.equal(outcome.file, null);
  assert.equal(outcome.summary, "Merged tea.");
  assert.deepEqual(outcome.counts["MEMORY.md"], {
    kept: 1,
    added: 0,
    merged: 1,
    replaced: 0,
    dropped: 0,
  });
  assert.equal(outcome.counts["USER.md"].replaced, 1);
  assert.deepEqual(outcome.chars, { "MEMORY.md": 40, "USER.md": 20 });
});

test("an unreadable answer is asked once more, then fails", async () => {
  const files = filesPort(start);
  const sessions = sessionsPort("no json", '{"MEMORY.md": [{"keep": "M9"}]}');
  const outcome = await dreamOnce({ files, sessions, agentId, chats: [] });
  assert.equal(sessions.calls.length, 2);
  assert.deepEqual(
    { outcome: outcome.outcome, reason: outcome.reason },
    { outcome: "failed", reason: "unreadable" },
  );
  assert.deepEqual(sets(files), []);
});

test("a broken answer that the second ask repairs is applied", async () => {
  const files = filesPort(start);
  const sessions = sessionsPort("no json", merged);
  const outcome = await dreamOnce({ files, sessions, agentId, chats: [] });
  assert.equal(sessions.calls.length, 2);
  assert.equal(outcome.outcome, "applied");
});

test("a night that drops a pin writes nothing", async () => {
  const files = filesPort(start);
  const sessions = sessionsPort({
    "MEMORY.md": [{ text: "Likes green tea", from: ["M2", "M3"] }],
    "USER.md": [{ keep: "U1" }],
    summary: "",
  });
  const outcome = await dreamOnce({ files, sessions, agentId, chats: [] });
  assert.deepEqual(
    { outcome: outcome.outcome, reason: outcome.reason, file: outcome.file },
    { outcome: "discarded", reason: "pinLost", file: "MEMORY.md" },
  );
  assert.equal(sets(files).length, 0);
  assert.deepEqual(files.store, start);
});

test("a night over the hard limit writes nothing", async () => {
  const files = filesPort(start);
  const sessions = sessionsPort({
    "MEMORY.md": [{ keep: "M1" }],
    "USER.md": [{ text: "x".repeat(5001) }],
    summary: "",
  });
  const outcome = await dreamOnce({ files, sessions, agentId, chats: [] });
  assert.deepEqual(
    { outcome: outcome.outcome, reason: outcome.reason, file: outcome.file },
    { outcome: "discarded", reason: "tooLarge", file: "USER.md" },
  );
  assert.equal(sets(files).length, 0);
});

test("a missing USER.md is created over its absence", async () => {
  const files = filesPort({ "MEMORY.md": "Likes tea" });
  const sessions = sessionsPort({
    "MEMORY.md": [{ keep: "M1" }],
    "USER.md": [{ text: "Name is Ada" }],
    summary: "",
  });
  const backups = [];
  const outcome = await dreamOnce({
    files,
    sessions,
    agentId,
    chats: [],
    backup: (contents) => backups.push(contents),
  });
  assert.deepEqual(backups, [{ "MEMORY.md": "Likes tea", "USER.md": null }]);
  assert.equal(outcome.outcome, "applied");
  assert.deepEqual(sets(files), [
    [
      "set",
      "USER.md",
      { content: "Name is Ada", expectedHash: undefined, expectedMissing: true },
    ],
  ]);
  assert.equal(files.store["USER.md"], "Name is Ada");
});

test("a conflict on the first file is a conflict", async () => {
  const files = filesPort(start, {
    beforeSet: (name, store) => {
      if (name === "MEMORY.md") store["MEMORY.md"] = "the agent wrote meanwhile";
    },
  });
  const outcome = await dreamOnce({ files, sessions: sessionsPort(merged), agentId });
  assert.deepEqual(
    { outcome: outcome.outcome, reason: outcome.reason, file: outcome.file },
    { outcome: "conflict", reason: "changed", file: "MEMORY.md" },
  );
  assert.deepEqual(
    sets(files).map(([, name]) => name),
    ["MEMORY.md"],
  );
  assert.equal(files.store["USER.md"], start["USER.md"]);
});

test("a conflict on the second file restores the first", async () => {
  const files = filesPort(start, {
    beforeSet: (name, store) => {
      if (name === "USER.md" && store["USER.md"] === start["USER.md"])
        store["USER.md"] = "the agent wrote meanwhile";
    },
  });
  const outcome = await dreamOnce({ files, sessions: sessionsPort(merged), agentId });
  assert.deepEqual(
    { outcome: outcome.outcome, reason: outcome.reason, file: outcome.file },
    { outcome: "conflict", reason: "changed", file: "USER.md" },
  );
  const written = sets(files);
  assert.deepEqual(
    written.map(([, name]) => name),
    ["MEMORY.md", "USER.md", "MEMORY.md"],
  );
  // The restore goes over the hash of what the dream had just written.
  const dreamt = written[0][2].content;
  assert.deepEqual(written[2][2], {
    content: start["MEMORY.md"],
    expectedHash: sha256(dreamt),
    expectedMissing: undefined,
  });
  assert.equal(files.store["MEMORY.md"], start["MEMORY.md"]);
  assert.equal(files.store["USER.md"], "the agent wrote meanwhile");
});

test("an unchanged file is not written", async () => {
  const files = filesPort(start);
  const sessions = sessionsPort({
    "MEMORY.md": [{ keep: "M1" }, { keep: "M2" }, { keep: "M3" }],
    "USER.md": [{ text: "Name is Ada Lovelace", from: ["U1"] }],
    summary: "",
  });
  const outcome = await dreamOnce({ files, sessions, agentId });
  assert.equal(outcome.outcome, "applied");
  assert.deepEqual(
    sets(files).map(([, name]) => name),
    ["USER.md"],
  );
});

test("an unreachable model fails as unavailable", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const files = filesPort(start);
  const down = Object.assign(Error("Hermes is not running"), { code: "UNAVAILABLE" });
  const sessions = sessionsPort(down);
  const outcome = await dreamOnce({ files, sessions, agentId });
  assert.deepEqual(
    { outcome: outcome.outcome, reason: outcome.reason },
    { outcome: "failed", reason: "unavailable" },
  );
  assert.equal(sets(files).length, 0);
  // Codes only, never memory text or the error's message.
  const logged = JSON.stringify(warn.mock.calls.map((c) => c.arguments));
  assert.match(logged, /UNAVAILABLE/);
  assert.doesNotMatch(logged, /quartz|not running/);
});
