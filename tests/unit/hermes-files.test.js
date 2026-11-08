import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { hermesAgentFiles } from "../../server/features/assistants/runtimes/hermes/hermes-files.js";
import { connectionOf } from "../../server/features/assistants/runtimes/hermes/hermes-connection.js";
import { memoryChars } from "../../server/features/assistants/runtimes/hermes/hermes-config/memory.js";

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const unavailable = (error) => error.code === "UNAVAILABLE" && error.status === 503;

// A supervisor stand-in: its client is ready until `client.ready` is set false, and
// its agent's folders live in a disposable directory.
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-files-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = {
    hermesHome: path.join(root, "state"),
    workspace: path.join(root, "work"),
  };
  fs.mkdirSync(agent.hermesHome);
  fs.mkdirSync(agent.workspace);
  const supervisor = { client: { ready: true }, agentPaths: () => agent };
  return { agent, supervisor, files: hermesAgentFiles(supervisor) };
}

test("Hermes memory files are Hermes's own, written only over the expected state", async (t) => {
  const { agent, files } = setup(t);
  const name = "MEMORY.md";
  assert.deepEqual((await files.get({ agentId: "ap-1", name })).file, {
    name,
    missing: true,
    content: "",
  });
  await files.set({ name, content: "quartz", expectedMissing: true });
  const file = path.join(agent.hermesHome, "memories", "MEMORY.md");
  assert.equal(fs.readFileSync(file, "utf8"), "quartz");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const { file: read } = await files.get({ name });
  assert.equal(read.hash, sha256("quartz"));
  await assert.rejects(
    files.set({ name, content: "x", expectedHash: sha256("other") }),
    (error) => error.code === "CONFLICT" && error.status === 409,
  );
  await assert.rejects(
    files.set({ name, content: "x", expectedMissing: true }),
    (error) => error.code === "CONFLICT",
  );
  await files.set({ name, content: "slate", expectedHash: read.hash });
  assert.equal((await files.get({ name })).file.content, "slate");
  // USER.md beside it; SOUL.md in the home and AGENTS.md in the work folder.
  await files.set({ name: "USER.md", content: "Owner likes tea", expectedMissing: true });
  assert.ok(fs.existsSync(path.join(agent.hermesHome, "memories", "USER.md")));
  await files.set({ name: "SOUL.md", content: "# Soul\n" });
  assert.equal(
    fs.readFileSync(path.join(agent.hermesHome, "SOUL.md"), "utf8"),
    "# Soul\n",
  );
  await files.set({ name: "AGENTS.md", content: "# Work\n" });
  assert.equal(
    fs.readFileSync(path.join(agent.workspace, "AGENTS.md"), "utf8"),
    "# Work\n",
  );
  // Hermes has no other file AgentPier names.
  await assert.rejects(
    files.get({ name: "TOOLS.md" }),
    (error) => error.code === "INVALID_REQUEST",
  );
});

test("a memory file over Hermes's limit is refused as Hermes counts it", async (t) => {
  const { files } = setup(t);
  const entry = "x".repeat(1000);
  // Two entries and the separator: 2003 characters, under MEMORY.md's 10000.
  const fits = `${entry}\n§\n${entry}`;
  assert.equal(memoryChars(fits), 2003);
  await files.set({ name: "MEMORY.md", content: fits });
  // Whitespace around entries and empty entries do not count.
  assert.equal(memoryChars(`  ${entry}  \n§\n\n§\n${entry}\n`), 2003);
  // Characters, not UTF-16 units: one emoji counts once.
  assert.equal(memoryChars("😀"), 1);
  await assert.rejects(
    files.set({ name: "USER.md", content: "y".repeat(5001) }),
    (error) => error.code === "TOO_LARGE" && error.status === 413 && error.limit === 5000,
  );
  await assert.rejects(
    files.set({ name: "MEMORY.md", content: "é".repeat(10001) }),
    (error) => error.code === "TOO_LARGE" && error.limit === 10000,
  );
  // 9999 two-byte characters, the separator and a pinned entry fit within 10000.
  await files.set({
    name: "MEMORY.md",
    content: `${"é".repeat(9970)}\n§\n📌 Owner drinks tea`,
  });
  assert.equal((await files.get({ name: "USER.md" })).file.missing, true);
  // Instructions have no such limit.
  await files.set({ name: "SOUL.md", content: "z".repeat(5000) });
});

test("memory search finds the entries that hold the query's words", async (t) => {
  const { files } = setup(t);
  await files.set({
    name: "MEMORY.md",
    content: "Project uses tabs\n§\nThe staging host\nneeds port 2222\n§\nOwner runs zsh",
  });
  await files.set({ name: "USER.md", content: "Prefers staging deploys on Fridays" });
  const found = await files.searchMemory({ query: "staging port", maxResults: 5 });
  assert.equal(found.ok, true);
  assert.deepEqual(found.output.details.results, [
    {
      path: "MEMORY.md",
      snippet: "The staging host\nneeds port 2222",
      startLine: 3,
      endLine: 4,
    },
    {
      path: "USER.md",
      snippet: "Prefers staging deploys on Fridays",
      startLine: 1,
      endLine: 1,
    },
  ]);
  assert.deepEqual(
    (await files.searchMemory({ query: "nothing", maxResults: 5 })).output.details
      .results,
    [],
  );
});

test("a file the agent replaced with a link is never read through", async (t) => {
  const { agent, files } = setup(t);
  const outside = path.join(agent.workspace, "secret.txt");
  fs.writeFileSync(outside, "host secret");
  fs.mkdirSync(path.join(agent.hermesHome, "memories"));
  fs.symlinkSync(outside, path.join(agent.hermesHome, "memories", "MEMORY.md"));
  await assert.rejects(files.get({ name: "MEMORY.md" }), (e) => e.code === "UNSAFE");
  // A write replaces the link, never the file it names.
  await files.set({ name: "MEMORY.md", content: "own" });
  assert.equal(fs.readFileSync(outside, "utf8"), "host secret");
  assert.equal((await files.get({ name: "MEMORY.md" })).file.content, "own");
});

test("Hermes files reject while the set is not ready and on a replaced connection", async (t) => {
  const { supervisor, files } = setup(t);
  const connection = connectionOf(supervisor.client);
  const bound = files.on(connection);
  assert.equal((await bound.get({ name: "MEMORY.md" })).file.missing, true);
  supervisor.client.ready = false;
  for (const call of [
    () => files.get({ name: "MEMORY.md" }),
    () => files.set({ name: "MEMORY.md", content: "x" }),
    () => files.searchMemory({ query: "x", maxResults: 1 }),
    () => bound.get({ name: "MEMORY.md" }),
  ])
    await assert.rejects(call(), unavailable);
  // A new client: the old view still reaches nothing.
  supervisor.client = { ready: true };
  await assert.rejects(bound.get({ name: "MEMORY.md" }), unavailable);
  assert.equal((await files.get({ name: "MEMORY.md" })).file.missing, true);
});
