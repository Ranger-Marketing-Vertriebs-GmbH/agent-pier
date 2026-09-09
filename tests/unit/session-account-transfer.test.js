import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareAccountTransfer } from "../../server/application/session-account-transfer.js";

async function fixture(t, tool) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "account-transfer-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    target = path.join(root, "target");
  await fs.mkdir(source);
  await fs.mkdir(target);
  const id = "11111111-1111-4111-8111-111111111111";
  const relative =
    tool === "codex"
      ? `sessions/2026/09/09/rollout-${id}.jsonl`
      : `projects/project/${id}.jsonl`;
  const file = path.join(source, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const record =
    tool === "codex"
      ? { type: "session_meta", payload: { id, cwd: root } }
      : {
          type: "user",
          sessionId: id,
          cwd: root,
          message: { role: "user", content: "Keep context" },
        };
  const text = JSON.stringify(record) + "\n";
  await fs.writeFile(file, text);
  for (const dir of [source, target])
    await fs.writeFile(path.join(dir, "auth.json"), dir);
  const session = { id: "session", accountId: "source", tool, cwd: root };
  const account = { id: "target", tool };
  const accounts = {
    environment: (id) => ({
      HOME: root,
      [tool === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]:
        id === "source" ? source : target,
    }),
  };
  const history = {
    claudeFile: async () => file,
    codex: () => ({ request: async () => ({ thread: { id, cwd: root, path: file } }) }),
  };
  return {
    root,
    source,
    target,
    file,
    relative,
    text,
    id,
    session,
    account,
    accounts,
    history,
    prepare() {
      return prepareAccountTransfer({ accounts, history }, session, account, id);
    },
  };
}
for (const tool of ["codex", "claude"]) {
  test(`${tool}: copy only selected history, snapshot after stop, allow return to older prefix`, async (t) => {
    const f = await fixture(t, tool);
    const transfer = await f.prepare();
    await assert.rejects(fs.access(path.join(f.target, f.relative)));
    const tail =
      JSON.stringify({ type: "event_msg", payload: { text: "last message" } }) + "\n";
    await fs.appendFile(f.file, tail);
    await transfer.commit();
    assert.equal(
      await fs.readFile(path.join(f.target, f.relative), "utf8"),
      f.text + tail,
    );
    assert.equal(await fs.readFile(path.join(f.target, "auth.json"), "utf8"), f.target);
    assert.equal(await fs.readFile(f.file, "utf8"), f.text + tail);
    assert.equal((await fs.stat(path.join(f.target, f.relative))).mode & 0o777, 0o600);
    await fs.appendFile(f.file, tail);
    await (await f.prepare()).commit();
    assert.equal(
      await fs.readFile(path.join(f.target, f.relative), "utf8"),
      f.text + tail + tail,
    );
  });
  test(`${tool}: divergent target history and symlinked destination cannot be overwritten`, async (t) => {
    const f = await fixture(t, tool);
    const dest = path.join(f.target, f.relative);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, "other conversation\n");
    await assert.rejects(f.prepare(), /different|diverg|conflict/i);
    await fs.rm(dest);
    await fs.symlink(f.file, dest);
    await assert.rejects(f.prepare(), /symbolic|symlink|unsafe/i);
    assert.equal(await fs.readFile(f.file, "utf8"), f.text);
  });
  test(`${tool}: reject wrong conversation and paths outside session storage`, async (t) => {
    const f = await fixture(t, tool);
    await fs.writeFile(
      f.file,
      JSON.stringify({ type: "user", sessionId: "wrong", cwd: f.root }) + "\n",
    );
    await assert.rejects(f.prepare(), /identity|conversation|history/i);
  });
}
test("Claude copies session subagents and rewind snapshots without other sessions", async (t) => {
  const f = await fixture(t, "claude");
  for (const relative of [
    `projects/project/${f.id}/subagents/agent-a.jsonl`,
    `file-history/${f.id}/snapshot@v1`,
  ]) {
    await fs.mkdir(path.dirname(path.join(f.source, relative)), { recursive: true });
    await fs.writeFile(path.join(f.source, relative), "session data");
  }
  await fs.writeFile(path.join(f.source, "projects/project/other.jsonl"), "unrelated");
  await (await f.prepare()).commit();
  assert.equal(
    await fs.readFile(path.join(f.target, `file-history/${f.id}/snapshot@v1`), "utf8"),
    "session data",
  );
  assert.equal(
    await fs.readFile(
      path.join(f.target, `projects/project/${f.id}/subagents/agent-a.jsonl`),
      "utf8",
    ),
    "session data",
  );
  await assert.rejects(fs.access(path.join(f.target, "projects/project/other.jsonl")));
});

test("Codex incomplete paginated history cannot be mistaken for a complete rollout", async (t) => {
  const f = await fixture(t, "codex");
  f.history.codex = () => ({
    request: async () => ({
      thread: { id: f.id, cwd: f.root, path: f.file, historyMode: "paginated" },
    }),
  });
  await assert.rejects(f.prepare(), /storage|format|portable/i);
  await assert.rejects(fs.access(path.join(f.target, f.relative)));
});

async function paginatedFixture(t) {
  const f = await fixture(t, "codex");
  f.records = [
    {
      ordinal: 0,
      type: "session_meta",
      payload: { id: f.id, cwd: f.root, history_mode: "paginated" },
    },
    {
      ordinal: 1,
      type: "response_item",
      payload: { type: "message", role: "user", content: "Keep all context" },
    },
  ];
  f.write = () => fs.writeFile(f.file, f.records.map(JSON.stringify).join("\n") + "\n");
  await f.write();
  f.history.codex = () => ({
    request: async (_method, params) => {
      if (params.includeTurns) throw Error("Use thread/turns/list for paginated history");
      return {
        thread: { id: f.id, cwd: f.root, path: f.file, historyMode: "paginated" },
      };
    },
  });
  return f;
}

test("Codex transfers a complete paginated rollout unchanged and snapshots the final append", async (t) => {
  const f = await paginatedFixture(t);
  const transfer = await f.prepare();
  f.records.push({
    ordinal: 2,
    type: "response_item",
    payload: { text: "Final output" },
  });
  await f.write();
  await transfer.commit();
  assert.equal(
    await fs.readFile(path.join(f.target, f.relative), "utf8"),
    await fs.readFile(f.file, "utf8"),
  );
  assert.equal(await fs.readFile(path.join(f.target, "auth.json"), "utf8"), f.target);
});

for (const corruption of ["missing", "gap", "duplicate", "start", "mode"]) {
  test(`Codex rejects paginated rollout with ${corruption} ordinal or storage marker before copying`, async (t) => {
    const f = await paginatedFixture(t);
    if (corruption === "missing") delete f.records[1].ordinal;
    if (corruption === "gap") f.records[1].ordinal = 2;
    if (corruption === "duplicate") f.records[1].ordinal = 0;
    if (corruption === "start") f.records.forEach((record) => record.ordinal++);
    if (corruption === "mode") delete f.records[0].payload.history_mode;
    await f.write();
    await assert.rejects(f.prepare(), /portable|incomplete|format/i);
    await assert.rejects(fs.access(path.join(f.target, f.relative)));
  });
}

test("Codex rechecks paginated completeness after the source process stops", async (t) => {
  const f = await paginatedFixture(t);
  const transfer = await f.prepare();
  f.records.push({ ordinal: 3, type: "response_item", payload: {} });
  await f.write();
  await assert.rejects(transfer.commit(), /portable|incomplete|format/i);
  await assert.rejects(fs.access(path.join(f.target, f.relative)));
});

test("Codex rejects unknown future storage modes", async (t) => {
  const f = await paginatedFixture(t);
  f.history.codex = () => ({
    request: async () => ({
      thread: { id: f.id, cwd: f.root, path: f.file, historyMode: "future" },
    }),
  });
  await assert.rejects(f.prepare(), /storage|format|portable/i);
});

test("Codex without a storage marker must support reading complete turns before transfer", async (t) => {
  const f = await fixture(t, "codex");
  f.history.codex = () => ({
    request: async (_method, params) => {
      if (params.includeTurns) throw Error("Full history unsupported");
      return { thread: { id: f.id, cwd: f.root, path: f.file } };
    },
  });
  await assert.rejects(f.prepare(), /unsupported/);
});

for (const key of ["id", "cwd", "path", "historyMode"]) {
  test(`Codex rejects a legacy ${key} change during the complete history read`, async (t) => {
    const f = await fixture(t, "codex");
    f.history.codex = () => ({
      request: async (_method, params) => ({
        thread: {
          id: f.id,
          cwd: f.root,
          path: f.file,
          historyMode: "legacy",
          ...(params.includeTurns ? { [key]: "changed" } : {}),
        },
      }),
    });
    await assert.rejects(f.prepare(), /changed during transfer/);
    await assert.rejects(fs.access(path.join(f.target, f.relative)));
  });
}
