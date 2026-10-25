import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { DreamingSettings } from "../../server/features/assistants/dreaming-settings.js";
import {
  DreamingBackups,
  backupMemory,
} from "../../server/features/assistants/dreaming-backups.js";
import { NativeMemory } from "../../server/features/assistants/native-memory.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { deleteNativeSession } from "../../server/features/assistants/chat-removal.js";

const model = { connectionId: "c", modelId: "m" };
const memoryOn = { capabilities: { memory: true, reminders: false } };
// 02:57 in Berlin (UTC+1 in November) on night `n`.
const night = (n, hour = 1, minute = 57) =>
  new Date(Date.UTC(2026, 10, 1 + n, hour, minute));

/** A data dir with the runtime's folders, agent store and the owner's switch. */
function fixture(t, { enabled = true, hour = 3, timeZone = "Europe/Berlin" } = {}) {
  const dataDir = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "assistant-dreaming-backups-"),
  );
  const paths = runtimePaths(dataDir);
  const store = new AssistantStore({ dataDir });
  const settings = new DreamingSettings({ dataDir });
  t.after(() => {
    settings.close();
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  settings.save({ enabled, hour, timeZone }, settings.get().revision);
  const assistants = { store, runtime: { paths }, admit: (fn) => fn() };
  const workspace = (agent) => path.join(paths.workspaces, agent.id);
  // The runtime's compiled roster, as agents.create persists it.
  const compile = (...agents) =>
    fs.writeFileSync(
      paths.config,
      JSON.stringify({
        agents: {
          entries: Object.fromEntries(
            [{ runtimeAgentId: "main" }, ...agents].map((a) => [a.runtimeAgentId, {}]),
          ),
        },
      }),
    );
  function agent(name, content = `${name} remembers`) {
    const created = store.createAssistant({ name, instructions: "", model });
    const saved = store.updateAssistant(created.id, memoryOn, created.revision);
    fs.mkdirSync(workspace(saved), { recursive: true });
    if (content !== null)
      fs.writeFileSync(path.join(workspace(saved), "MEMORY.md"), content);
    return saved;
  }
  const folder = (agent) => path.join(paths.root, "memory-backups", agent.runtimeAgentId);
  const backups = (agent) => {
    try {
      return fs.readdirSync(folder(agent)).sort();
    } catch {
      return [];
    }
  };
  return {
    dataDir,
    paths,
    store,
    settings,
    assistants,
    workspace,
    compile,
    agent,
    folder,
    backups,
  };
}

test("a backup of MEMORY.md is taken before the night's run and seven are kept", async (t) => {
  const f = fixture(t);
  const orchid = f.agent("Orchid");
  f.compile(orchid);
  const memory = path.join(f.workspace(orchid), "MEMORY.md");
  for (let n = 0; n < 9; n++) {
    fs.writeFileSync(memory, `night ${n}`);
    const backups = new DreamingBackups({
      settings: f.settings,
      assistants: f.assistants,
    });
    await backups.run(night(n));
  }
  const files = f.backups(orchid);
  assert.equal(files.length, 7);
  for (const name of files) assert.match(name, /^MEMORY-\d{8}T\d{9}Z\.md$/);
  assert.equal(files.at(-1), "MEMORY-20261109T015700000Z.md");
  assert.equal(
    fs.readFileSync(path.join(f.folder(orchid), files.at(-1)), "utf8"),
    "night 8",
  );
  assert.equal(fs.readFileSync(path.join(f.folder(orchid), files[0]), "utf8"), "night 2");
  for (const name of files)
    assert.equal(fs.statSync(path.join(f.folder(orchid), name)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.folder(orchid)).mode & 0o777, 0o700);
  // Outside the workspace: never in the memory view or the agent's own files.
  assert.deepEqual(
    fs.readdirSync(f.workspace(orchid)).filter((name) => name.startsWith("MEMORY-")),
    [],
  );
  const listed = await new NativeMemory(f.assistants, {
    workspaces: f.paths.workspaces,
  }).files(orchid.id);
  assert.equal(JSON.stringify(listed).includes("MEMORY-"), false);
});

test("a missing or linked MEMORY.md takes no backup", async (t) => {
  const f = fixture(t);
  const missing = f.agent("Missing", null);
  const linked = f.agent("Linked", null);
  const outside = path.join(f.dataDir, "outside.md");
  fs.writeFileSync(outside, "not the agent's memory");
  fs.symlinkSync(outside, path.join(f.workspace(linked), "MEMORY.md"));
  // A workspace that is itself a link is refused too.
  const moved = f.agent("Moved");
  const real = path.join(f.dataDir, "elsewhere");
  fs.renameSync(f.workspace(moved), real);
  fs.symlinkSync(real, f.workspace(moved));
  for (const agent of [missing, linked, moved])
    assert.equal(backupMemory(f.paths, agent, { now: night(0) }), null, agent.name);
  f.compile(missing, linked, moved);
  await new DreamingBackups({ settings: f.settings, assistants: f.assistants }).run(
    night(0),
  );
  for (const agent of [missing, linked, moved])
    assert.deepEqual(f.backups(agent), [], agent.name);
});

test("temporary members are backed up too", async (t) => {
  const f = fixture(t);
  const lead = f.agent("Lead");
  const member = f.store.reserveMember({
    id: "member-task",
    parent: lead.id,
    assignment: { name: "Task" },
    snapshot: { model, instructions: "" },
    teamId: "team",
    lifetime: "task",
  });
  fs.mkdirSync(f.workspace(member), { recursive: true });
  fs.writeFileSync(path.join(f.workspace(member), "MEMORY.md"), "task notes");
  f.compile(lead, member);
  await new DreamingBackups({ settings: f.settings, assistants: f.assistants }).run(
    night(0),
  );
  assert.equal(f.backups(member).length, 1);
  assert.equal(f.backups(lead).length, 1);
  // An agent the runtime has not compiled (yet) is not backed up.
  const later = f.agent("Later");
  await new DreamingBackups({ settings: f.settings, assistants: f.assistants }).run(
    night(1),
  );
  assert.deepEqual(f.backups(later), []);
});

test("a restart in the backup window takes no second copy", async (t) => {
  const f = fixture(t);
  const orchid = f.agent("Orchid");
  f.compile(orchid);
  await new DreamingBackups({ settings: f.settings, assistants: f.assistants }).run(
    night(0, 1, 56),
  );
  const restarted = new DreamingBackups({
    settings: f.settings,
    assistants: f.assistants,
  });
  await restarted.run(night(0, 1, 58));
  await restarted.run(night(0, 1, 59));
  assert.equal(f.backups(orchid).length, 1);
});

test("no backup while dreaming is off or outside the window, and an hour change moves it", async (t) => {
  const f = fixture(t, { enabled: false });
  const orchid = f.agent("Orchid");
  f.compile(orchid);
  const backups = new DreamingBackups({ settings: f.settings, assistants: f.assistants });
  await backups.run(night(0));
  assert.deepEqual(f.backups(orchid), [], "dreaming off");
  const save = (input) => f.settings.save(input, f.settings.get().revision);
  save({ enabled: true, hour: 3, timeZone: "Europe/Berlin" });
  // 02:50 and 03:00 lie outside the five minutes before the hour.
  for (const at of [night(0, 1, 50), night(0, 2, 0), night(0, 3, 57)])
    await backups.run(at);
  assert.deepEqual(f.backups(orchid), [], "outside the window");
  save({ enabled: true, hour: 5, timeZone: "Europe/Berlin" });
  await backups.run(night(0, 1, 57));
  assert.deepEqual(f.backups(orchid), [], "the old hour");
  await backups.run(night(0, 3, 55));
  assert.deepEqual(f.backups(orchid), ["MEMORY-20261101T035500000Z.md"]);
  // The window follows the zone: 04:57 in UTC.
  save({ enabled: true, hour: 5, timeZone: "UTC" });
  await backups.run(night(1, 4, 57));
  assert.equal(f.backups(orchid).length, 2);
});

test("backups of a removed agent are deleted", async (t) => {
  const f = fixture(t);
  const kept = f.agent("Kept");
  const removed = f.agent("Removed");
  f.compile(kept, removed);
  const backups = new DreamingBackups({ settings: f.settings, assistants: f.assistants });
  await backups.run(night(0));
  assert.equal(f.backups(removed).length, 1);
  // Deleted, or a temporary member whose task ended: its workspace is gone.
  fs.rmSync(f.workspace(removed), { recursive: true });
  f.compile(kept);
  f.settings.save(
    { enabled: false, hour: 3, timeZone: "UTC" },
    f.settings.get().revision,
  );
  await backups.run(night(0, 12, 0));
  assert.equal(fs.existsSync(f.folder(removed)), false);
  assert.equal(f.backups(kept).length, 1);
});

test("a tick reads the clock once admitted", async (t) => {
  const f = fixture(t);
  const orchid = f.agent("Orchid");
  f.compile(orchid);
  let at = night(0, 1, 50);
  // Admission was held until the run had begun: the queued tick acts at 02:58.
  const assistants = {
    ...f.assistants,
    admit: (fn) => {
      at = night(0, 1, 58);
      return fn();
    },
  };
  const clock = () => at;
  await new DreamingBackups({ settings: f.settings, assistants, clock }).run();
  assert.deepEqual(f.backups(orchid), ["MEMORY-20261101T015800000Z.md"]);
});

test("a missing workspaces root removes no backups", async (t) => {
  const f = fixture(t);
  const orchid = f.agent("Orchid");
  f.compile(orchid);
  const backups = new DreamingBackups({ settings: f.settings, assistants: f.assistants });
  await backups.run(night(0));
  fs.rmSync(f.paths.workspaces, { recursive: true });
  await backups.run(night(0, 12, 0));
  assert.equal(f.backups(orchid).length, 1);
});

test("a half-written copy is never a backup and is cleared", async (t) => {
  const f = fixture(t);
  const orchid = f.agent("Orchid");
  f.compile(orchid);
  fs.mkdirSync(f.folder(orchid), { recursive: true, mode: 0o700 });
  // A crash during the copy before night 0's window.
  fs.writeFileSync(
    path.join(f.folder(orchid), "MEMORY-20261101T015500000Z.md.tmp"),
    "Orch",
  );
  const backups = new DreamingBackups({ settings: f.settings, assistants: f.assistants });
  await backups.run(night(0));
  assert.deepEqual(f.backups(orchid), ["MEMORY-20261101T015700000Z.md"]);
});

test("the clock change nights take one backup each", async (t) => {
  const f = fixture(t);
  const orchid = f.agent("Orchid");
  f.compile(orchid);
  const backups = new DreamingBackups({ settings: f.settings, assistants: f.assistants });
  // 2027-03-28 in Berlin: 02:00 CET jumps to 03:00 CEST, so 02:55-02:59 never
  // happens; 01:57 CET (00:57Z) lies three minutes before 03:00.
  await backups.run(new Date(Date.UTC(2027, 2, 28, 0, 52)));
  assert.deepEqual(f.backups(orchid), [], "earlier than five minutes before");
  await backups.run(new Date(Date.UTC(2027, 2, 28, 0, 57)));
  assert.deepEqual(f.backups(orchid), ["MEMORY-20270328T005700000Z.md"]);
  await backups.run(new Date(Date.UTC(2027, 2, 28, 1, 0)));
  assert.equal(f.backups(orchid).length, 1, "not at the hour itself");
  // 2027-10-31: 02:57 happens twice (CEST, then CET); the second takes no copy.
  await backups.run(new Date(Date.UTC(2027, 9, 31, 0, 57)));
  await backups.run(new Date(Date.UTC(2027, 9, 31, 1, 57)));
  assert.deepEqual(f.backups(orchid).slice(1), ["MEMORY-20271031T005700000Z.md"]);
});

test("a chat deletion does not wait for the forget", async (t) => {
  const done = path.join(
    fs.realpathSync(os.tmpdir()),
    `forget-slow-${process.pid}-${Date.now()}`,
  );
  t.after(() => fs.rmSync(done, { force: true }));
  const f = deletion(
    t,
    `import fs from "node:fs";
setTimeout(() => fs.writeFileSync(${JSON.stringify(done)}, "done"), 1500);`,
  );
  assert.equal(await deleteNativeSession(f.assistants, f.chat), true);
  assert.equal(fs.existsSync(done), false, "the forget is still running");
  await f.assistants.dreamingForgets;
  assert.equal(fs.existsSync(done), true);
});

/** A chat with a known native session, and a runtime whose CLI is `script`. */
function deletion(t, script) {
  const f = fixture(t);
  const orchid = f.agent("Orchid");
  const chat = f.store.saveConversation({
    assistantId: orchid.id,
    runtimeSessionKey: `agent:${orchid.runtimeAgentId}:chat`,
  });
  f.store.updateConversation(chat.id, { nativeSessionId: "session-1" });
  const entryPath = path.join(f.dataDir, "openclaw.mjs");
  fs.writeFileSync(entryPath, script);
  const calls = [];
  f.assistants.runtime.client = {
    ready: true,
    async call(method) {
      calls.push(method);
      return method === "sessions.describe"
        ? { session: { sessionId: "session-1" } }
        : {};
    },
  };
  f.assistants.runtime.runtime = { nodePath: process.execPath, entryPath };
  f.assistants.ledger = { forgetTexts() {} };
  return { ...f, orchid, chat, calls };
}

test("a deleted chat leaves dreaming through the runtime's memory forget", async (t) => {
  const record = path.join(
    fs.realpathSync(os.tmpdir()),
    `forget-${process.pid}-${Date.now()}`,
  );
  t.after(() => fs.rmSync(record, { force: true }));
  const f = deletion(
    t,
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), state: process.env.OPENCLAW_STATE_DIR }));
console.log("{}");`,
  );
  assert.equal(await deleteNativeSession(f.assistants, f.chat), true);
  await f.assistants.dreamingForgets;
  assert.deepEqual(f.calls, ["sessions.delete"]);
  const seen = JSON.parse(fs.readFileSync(record, "utf8"));
  assert.deepEqual(seen.args, [
    "memory",
    "forget",
    "--agent",
    f.orchid.runtimeAgentId,
    "--session",
    "session-1",
    "--json",
  ]);
  assert.equal(seen.cwd, f.paths.root);
  assert.equal(seen.state, f.paths.state);
});

test("a failed forget does not fail the chat deletion", async (t) => {
  const f = deletion(t, `console.error("session-1 DREAMSECRET"); process.exit(3);`);
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  assert.equal(await deleteNativeSession(f.assistants, f.chat), true);
  assert.equal(f.store.storedConversation(f.chat.id).nativeDeletePending, false);
  await f.assistants.dreamingForgets;
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /session-1|DREAMSECRET/);
});
