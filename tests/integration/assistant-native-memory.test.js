import test from "node:test";
import assert from "node:assert/strict";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import { NativeMemory } from "../../server/features/assistants/native-memory.js";
function fixture(t) {
  const f = channelFixture(t),
    calls = [];
  const id = f.channel.assistantId;
  f.store.updateAssistant(id, { capabilities: { memory: true, reminders: false } }, 1);
  f.assistants.admit = (fn) => fn();
  f.assistants.requireReady = () => {};
  f.assistants.config = { apply: async () => {} };
  f.assistants.runtime.client.call = async (method, args) => {
    calls.push({ method, args });
    if (method === "agents.files.get")
      return {
        file: {
          name: args.name,
          path: "/private/host",
          content: "Saved fact",
          hash: "a".repeat(64),
        },
      };
    if (method === "agents.files.set")
      return { file: { name: args.name, content: args.content, hash: "b".repeat(64) } };
    return {
      ok: true,
      output: {
        details: {
          results: [
            {
              path: "memory/notes.md",
              snippet: "Saved fact",
              startLine: 1,
              endLine: 2,
              hostPath: "/private",
            },
          ],
        },
      },
    };
  };
  return { ...f, id, calls, memory: new NativeMemory(f.assistants) };
}
test("memory uses exact native agent and strips host paths from files and search", async (t) => {
  const f = fixture(t);
  const file = await f.memory.read(f.id, "MEMORY.md");
  assert.equal(file.content, "Saved fact");
  assert.equal(file.path, undefined);
  const search = await f.memory.search(f.id, "fact");
  assert.equal(search.results[0].snippet, "Saved fact");
  assert.ok(!JSON.stringify(search).includes("/private"));
  assert.equal(f.calls[0].args.agentId, f.store.getAssistant(f.id).runtimeAgentId);
  assert.equal(f.calls[1].args.agentId, f.store.getAssistant(f.id).runtimeAgentId);
});
test("native file writes carry compare-and-swap and allow explicit clearing", async (t) => {
  const f = fixture(t);
  await f.memory.write(f.id, {
    name: "MEMORY.md",
    content: "",
    expectedHash: "a".repeat(64),
  });
  assert.equal(f.calls[0].args.expectedHash, "a".repeat(64));
  assert.equal(f.calls[0].args.content, "");
  f.assistants.runtime.client.call = async () => {
    throw Object.assign(Error(), { code: "CONFLICT" });
  };
  await assert.rejects(
    f.memory.write(f.id, {
      name: "MEMORY.md",
      content: "stale",
      expectedHash: "a".repeat(64),
    }),
    { status: 409 },
  );
});
test("memory refuses path traversal, blind writes and revoked grants before native calls", async (t) => {
  const f = fixture(t);
  for (const name of ["../MEMORY.md", "AGENTS.md", "/etc/passwd"])
    await assert.rejects(f.memory.read(f.id, name), { status: 400 });
  await assert.rejects(f.memory.write(f.id, { name: "MEMORY.md", content: "blind" }), {
    status: 400,
  });
  f.store.updateAssistant(f.id, { capabilities: { memory: false, reminders: false } }, 2);
  await assert.rejects(f.memory.search(f.id, "fact"), { status: 403 });
  assert.equal(f.calls.length, 0);
});
test("notes the agent writes under memory/ are listed and readable, never writable or escapable", async (t) => {
  const f = fixture(t),
    fs = await import("node:fs"),
    os = await import("node:os"),
    path = await import("node:path");
  const workspaces = fs.mkdtempSync(path.join(os.tmpdir(), "memory-workspaces-"));
  t.after(() => fs.rmSync(workspaces, { recursive: true, force: true }));
  const memory = new NativeMemory(f.assistants, { workspaces });
  const root = path.join(workspaces, f.id, "memory");
  fs.mkdirSync(path.join(root, "topics"), { recursive: true });
  fs.writeFileSync(path.join(root, "MEMORY.md"), "User likes tea");
  fs.writeFileSync(path.join(root, "2026-10-10.md"), "Daily note");
  fs.writeFileSync(path.join(root, "topics", "cats.md"), "Cat names");
  fs.writeFileSync(path.join(root, "notes.txt"), "not memory");
  fs.writeFileSync(path.join(workspaces, "secret.md"), "outside");
  fs.symlinkSync(path.join(workspaces, "secret.md"), path.join(root, "link.md"));
  const { files } = await memory.files(f.id);
  assert.deepEqual(files.map((x) => x.name).sort(), [
    "memory/2026-10-10.md",
    "memory/MEMORY.md",
    "memory/topics/cats.md",
  ]);
  const note = await memory.read(f.id, "memory/MEMORY.md");
  assert.equal(note.content, "User likes tea");
  assert.equal(note.readOnly, true);
  assert.ok(!JSON.stringify([files, note]).includes(workspaces));
  for (const name of ["memory/link.md", "memory/../secret.md", "memory/notes.txt"])
    await assert.rejects(memory.read(f.id, name), { status: 400 });
  await assert.rejects(
    memory.write(f.id, { name: "memory/MEMORY.md", content: "x", expectedMissing: true }),
    { status: 400 },
  );
});
test("a symlinked memory/ folder or workspace is never listed or read", async (t) => {
  const f = fixture(t),
    fs = await import("node:fs"),
    os = await import("node:os"),
    path = await import("node:path");
  const workspaces = fs.mkdtempSync(path.join(os.tmpdir(), "memory-workspaces-"));
  t.after(() => fs.rmSync(workspaces, { recursive: true, force: true }));
  const memory = new NativeMemory(f.assistants, { workspaces });
  const outside = path.join(workspaces, "outside");
  fs.mkdirSync(path.join(outside, "memory"), { recursive: true });
  fs.writeFileSync(path.join(outside, "memory", "secret.md"), "outside");
  fs.mkdirSync(path.join(workspaces, f.id));
  fs.symlinkSync(path.join(outside, "memory"), path.join(workspaces, f.id, "memory"));
  assert.deepEqual((await memory.files(f.id)).files, []);
  await assert.rejects(memory.read(f.id, "memory/secret.md"), { status: 400 });
  fs.rmSync(path.join(workspaces, f.id), { recursive: true });
  fs.symlinkSync(outside, path.join(workspaces, f.id));
  assert.deepEqual((await memory.files(f.id)).files, []);
  await assert.rejects(memory.read(f.id, "memory/secret.md"), { status: 400 });
});
test("memory/ notes follow the same availability gate as the root notes", async (t) => {
  const f = fixture(t),
    fs = await import("node:fs"),
    os = await import("node:os"),
    path = await import("node:path");
  const workspaces = fs.mkdtempSync(path.join(os.tmpdir(), "memory-workspaces-"));
  t.after(() => fs.rmSync(workspaces, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspaces, f.id, "memory"), { recursive: true });
  fs.writeFileSync(path.join(workspaces, f.id, "memory", "note.md"), "Note");
  const memory = new NativeMemory(f.assistants, { workspaces });
  f.assistants.admit = async () => {
    throw Object.assign(Error("maintenance"), { status: 503 });
  };
  await assert.rejects(memory.files(f.id), { status: 503 });
  await assert.rejects(memory.read(f.id, "memory/note.md"), { status: 503 });
});
