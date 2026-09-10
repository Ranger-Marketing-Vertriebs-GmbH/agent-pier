import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ProviderHistory,
  readJsonLines,
} from "../../server/features/chat/provider-history.js";
import { AccountStore } from "../../server/features/accounts/account-store.js";

const id = "11111111-1111-4111-8111-111111111111";
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-history-"));
  const accounts = new AccountStore({ dataDir: path.join(dir, "data"), home: dir });
  const history = new ProviderHistory({ accounts, home: dir });
  t.after(async () => {
    await history.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const cwd = path.join(dir, "project");
  await fs.mkdir(cwd);
  return { dir, accounts, history, cwd };
}
async function transcript(root, cwd, sessionId, records) {
  const directory = path.join(root, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, sessionId + ".jsonl");
  await fs.writeFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}
test("Claude history is restricted to the exact profile, cwd and conversation ID", async (t) => {
  const { dir, accounts, history, cwd } = await fixture(t);
  const a = accounts.create({ name: "one", tool: "claude" }),
    b = accounts.create({ name: "two", tool: "claude" });
  const record = (text) => ({
    type: "user",
    uuid: "msg-1",
    sessionId: id,
    cwd,
    message: { role: "user", content: text },
  });
  const file = await transcript(accounts.environment(a.id).CLAUDE_CONFIG_DIR, cwd, id, [
    record("my own message"),
  ]);
  await transcript(accounts.environment(b.id).CLAUDE_CONFIG_DIR, cwd, id, [
    record("other account secret"),
  ]);
  const session = { tool: "claude", accountId: a.id, cwd };
  assert.equal((await history.list(session))[0].id, id);
  const result = await history.read(session, id);
  assert.equal(result.messages[0].text, "my own message");
  assert.equal(JSON.stringify(result).includes("other account secret"), false);
  await assert.rejects(history.read(session, "../outside"), /ID/);
  await fs.writeFile(
    file,
    JSON.stringify({ ...record("wrong workspace"), cwd: dir }) + "\n",
  );
  await assert.rejects(history.read(session, id), /Projekt|Sitzung/);
});
test("JSONL ignores a partial final write, retains completed records and rejects oversized input", async (t) => {
  const { dir } = await fixture(t);
  const file = path.join(dir, "partial.jsonl");
  await fs.writeFile(file, '{"type":"user"}\n{"type":');
  assert.deepEqual(await readJsonLines(file), [{ type: "user" }]);
  await assert.rejects(readJsonLines(file, 4), /groß/);
});
test("Claude discovery does not follow transcript symlinks outside the profile", async (t) => {
  const { dir, history, cwd } = await fixture(t);
  const root = path.join(dir, ".claude");
  const file = await transcript(root, cwd, id, []);
  const outside = path.join(dir, "outside.jsonl");
  await fs.writeFile(
    outside,
    JSON.stringify({
      type: "user",
      cwd,
      sessionId: id,
      message: { content: "outside" },
    }) + "\n",
  );
  await fs.unlink(file);
  await fs.symlink(outside, file);
  const session = { tool: "claude", accountId: "local-claude", cwd };
  assert.deepEqual(await history.list(session), []);
  await assert.rejects(history.read(session, id), /Sitzung|Profil/);
});
test("empty or partial Claude startup logs wait; null records cannot break discovery", async (t) => {
  const { dir, history, cwd } = await fixture(t);
  const session = { tool: "claude", accountId: "local-claude", cwd };
  const file = await transcript(path.join(dir, ".claude"), cwd, id, []);
  await assert.rejects(history.read(session, id), { status: 404 });
  await fs.writeFile(file, '{"type":');
  await assert.rejects(history.read(session, id), { status: 404 });
  await fs.writeFile(
    file,
    "null\n42\n" +
      JSON.stringify({
        type: "user",
        uuid: "m",
        sessionId: id,
        cwd,
        message: { role: "user", content: "Valid" },
      }) +
      "\n",
  );
  assert.equal((await history.list(session))[0].id, id);
  assert.equal((await history.read(session, id)).messages[0].text, "Valid");
});
test("paginated Codex history keeps newest turns and restores chronological order", async (t) => {
  const { history, cwd } = await fixture(t);
  const session = { tool: "codex", accountId: "local-codex", cwd };
  const pages = [];
  history.codex = () => ({
    request: async (method, params) => {
      if (method === "thread/read") {
        if (params.includeTurns) throw Object.assign(Error("paginated"), { status: 409 });
        return { thread: { id, cwd } };
      }
      assert.equal(params.sortDirection, "desc");
      pages.push(params);
      const start = params.cursor ? Number(params.cursor) : 1000;
      const turns = Array.from({ length: Math.min(100, start + 1) }, (_, i) => ({
        id: String(start - i),
        items: [
          { type: "agentMessage", id: "m" + (start - i), text: "Turn " + (start - i) },
        ],
      }));
      return { data: turns, nextCursor: start >= 100 ? String(start - 100) : null };
    },
  });
  const result = await history.read(session, id);
  assert.equal(result.messages.at(-1).text, "Turn 1000");
  assert.equal(result.messages[0].text, "Turn 0");
  assert.equal(pages.length, 11);
});
test("Codex history clients are isolated per account and project", async (t) => {
  const { history, cwd } = await fixture(t);
  const otherCwd = path.join(path.dirname(cwd), "other-project");
  await fs.mkdir(otherCwd);
  const clients = [];
  history.codexClientFactory = () => {
    const client = { closed: false, close: async () => {} };
    clients.push(client);
    return client;
  };
  const accountId = "local-codex";
  const first = history.codex({ tool: "codex", accountId, cwd });
  const second = history.codex({ tool: "codex", accountId, cwd: otherCwd });
  assert.notEqual(first, second);
  assert.equal(clients.length, 2);
});
test("Codex history retries once after a disconnected app-server", async (t) => {
  const { history, cwd } = await fixture(t);
  history.executable = () => "codex";
  let attempts = 0;
  history.codexClientFactory = () => {
    const first = attempts++ === 0;
    return {
      closed: first,
      request: async () => {
        if (first) throw Object.assign(Error("disconnected"), { status: 503 });
        return { data: [] };
      },
      close: async () => {},
    };
  };
  assert.deepEqual(
    await history.list({ tool: "codex", accountId: "local-codex", cwd }),
    [],
  );
  assert.equal(attempts, 2);
});
test("installed Codex app-server supports isolated read-only history and shuts down cleanly", async (t) => {
  const { detectTools } = await import("../../server/features/accounts/account-store.js");
  const command = detectTools().find((tool) => tool.id === "codex")?.path;
  if (!command) return t.skip("Codex is not installed");
  const { dir } = await fixture(t);
  const { CodexHistoryClient } =
    await import("../../server/features/chat/provider-history.js");
  const codexHome = path.join(dir, "codex");
  await fs.mkdir(codexHome);
  const client = new CodexHistoryClient(
    command,
    { HOME: dir, CODEX_HOME: codexHome, PATH: process.env.PATH, LANG: "en_US.UTF-8" },
    dir,
  );
  t.after(() => client.close());
  const result = await client.request("thread/list", { cwd: dir, limit: 10 });
  assert.deepEqual(result.data, []);
  assert.throws(() => client.rpc("turn/start", {}), /lesende/);
  await client.close();
  assert.ok(client.child.exitCode !== null || client.child.signalCode !== null);
});
test("history shutdown kills and awaits OpenCode exports and prevents new history processes", async (t) => {
  const { dir, history, cwd } = await fixture(t);
  const binary = path.join(dir, "opencode-fixture");
  await fs.writeFile(
    binary,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.HOME+'/export.pid',String(process.pid));setInterval(()=>{},1000);\n`,
    { mode: 0o700 },
  );
  history.executable = () => binary;
  const operation = history.list({ tool: "opencode", accountId: "local-opencode", cwd });
  const rejected = assert.rejects(operation);
  let pid;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      pid = Number(await fs.readFile(path.join(dir, "export.pid"), "utf8"));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  assert.ok(pid);
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  });
  await history.close();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await rejected;
  await assert.rejects(
    history.list({ tool: "opencode", accountId: "local-opencode", cwd }),
    { status: 503 },
  );
});
