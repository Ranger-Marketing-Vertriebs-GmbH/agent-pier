import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chatTaskRoutes } from "../../server/http/routes/chat-tasks.js";
import { TaskReads } from "../../server/features/chat/task-reads.js";
import { problem } from "../../server/lib/storage.js";

const NATIVE = "11111111-2222-3333-4444-555555555555";
const AGENT = "ad8fe347eb34a68b1";
const SHELL = "biedr05v9";
const SECRET = "SECRET-CONTENT";
const fixtureFile = fs.readFileSync(
  new URL("../fixtures/observability/claude-subagent-file.jsonl", import.meta.url),
  "utf8",
);

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** An Express app with the task routes over stub chat, history and sessions. */
async function app(
  t,
  { tool = "claude", subagents = [], shells = [], history = {} } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-reads-"));
  const temp = path.join(root, "tmp");
  const project = path.join(root, "projects", "slug");
  fs.mkdirSync(temp, { recursive: true });
  const outputs = new Map();
  const opened = [];
  const session = { id: "s1", tool, cwd: "/work", status: "running" };
  const chat = {
    read: async (id) => {
      if (id !== "s1") throw problem("Missing", 404);
      return {
        availability: "ready",
        providerSessionId: NATIVE,
        observability: { subagents, shells },
      };
    },
    shellOutputFile: (id, shell) => {
      opened.push(["shellOutputFile", id, shell]);
      return id === "s1" ? (outputs.get(shell) ?? null) : null;
    },
  };
  const sessions = {
    get: async (id) => {
      if (id !== "s1") throw problem("Missing", 404);
      return session;
    },
  };
  const reads = new TaskReads({
    sessions,
    chat,
    uid: 4242,
    tempRoots: [temp],
    history: {
      claudeFile: async () => {
        opened.push(["claudeFile"]);
        return path.join(project, `${NATIVE}.jsonl`);
      },
      ...history,
    },
  });
  const server = express();
  server.use("/api", chatTaskRoutes({ taskReads: reads }));
  server.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const listener = await new Promise((resolve) => {
    const started = server.listen(0, "127.0.0.1", () => resolve(started));
  });
  t.after(() => {
    listener.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const get = async (suffix) => {
    const response = await fetch(`${base}/api/sessions/${suffix}`);
    return { status: response.status, body: await response.json() };
  };
  return { get, root, temp, project, outputs, opened };
}

const subagent = (id, status = "completed") => ({ id, name: "x", task: "t", status });
const shell = (id) => ({ id, command: "sleep 1", status: "running" });
const transcript = (id) => `s1/tasks/${id}/transcript`;
const output = (id) => `s1/tasks/${id}/output`;

test("a Claude subagent transcript is served for a listed id and skips request records", async (t) => {
  const f = await app(t, { subagents: [subagent(AGENT)] });
  write(path.join(f.project, NATIVE, "subagents", `agent-${AGENT}.jsonl`), fixtureFile);
  const ok = await f.get(transcript(AGENT));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.partial, false);
  assert.equal(ok.body.truncated, false);
  assert.ok(ok.body.messages.length > 0);
  assert.equal(
    ok.body.messages.some((m) => String(m.id).startsWith("api-request")),
    false,
  );
  assert.equal(JSON.stringify(ok.body).includes("api-request"), false);
});

test("ids the observability does not list never open a file", async (t) => {
  const f = await app(t, { subagents: [subagent(AGENT)] });
  write(path.join(f.project, NATIVE, "subagents", `agent-${AGENT}.jsonl`), fixtureFile);
  write(
    path.join(f.project, NATIVE, "subagents", "agent-otheragent01.jsonl"),
    fixtureFile,
  );
  for (const id of ["..%2F..%2Fetc%2Fpasswd", "agent-x%00", "otheragent01"]) {
    const res = await f.get(transcript(id));
    assert.equal(res.status, 404);
    assert.equal((await f.get(output(id))).status, 404);
  }
  assert.deepEqual(f.opened, []); // no file was looked up for an unlisted id
  assert.equal((await f.get("missing/tasks/x/transcript")).status, 404);
  assert.equal((await f.get("missing/tasks/x/output")).status, 404);
});

test("a symlinked transcript or subagent folder is refused", async (t) => {
  const f = await app(t, { subagents: [subagent(AGENT)] });
  const outside = path.join(f.root, "outside.jsonl");
  write(outside, fixtureFile);
  const folder = path.join(f.project, NATIVE, "subagents");
  fs.mkdirSync(folder, { recursive: true });
  fs.symlinkSync(outside, path.join(folder, `agent-${AGENT}.jsonl`));
  assert.equal((await f.get(transcript(AGENT))).status, 409);
});

test("a long subagent transcript returns the newest 50 messages", async (t) => {
  const f = await app(t, { subagents: [subagent(AGENT)] });
  const lines = [];
  for (let i = 0; i < 60; i++)
    lines.push(
      JSON.stringify({
        type: "user",
        isSidechain: true,
        agentId: AGENT,
        uuid: `u${i}`,
        timestamp: "2026-11-16T20:16:19.277Z",
        message: { role: "user", content: `message ${i}` },
      }),
    );
  write(
    path.join(f.project, NATIVE, "subagents", `agent-${AGENT}.jsonl`),
    lines.join("\n") + "\n",
  );
  const { body } = await f.get(transcript(AGENT));
  assert.equal(body.messages.length, 50);
  assert.equal(body.truncated, true);
  assert.equal(body.messages.at(-1).text, "message 59");
});

test("a listed subagent without a file answers 409", async (t) => {
  const f = await app(t, { subagents: [subagent(AGENT)] });
  assert.equal((await f.get(transcript(AGENT))).status, 409);
});

function shellFile(f, { uid = 4242, session = NATIVE, id = SHELL, text = SECRET } = {}) {
  const file = path.join(
    f.temp,
    `claude-${uid}`,
    "slug",
    session,
    "tasks",
    `${id}.output`,
  );
  write(file, text);
  return file;
}

test("a shell output tail is served, and a missing file is gone", async (t) => {
  const f = await app(t, { shells: [shell(SHELL)] });
  assert.deepEqual((await f.get(output(SHELL))).body, {
    text: "",
    truncated: false,
    gone: true,
  });
  f.outputs.set(SHELL, shellFile(f));
  assert.deepEqual((await f.get(output(SHELL))).body, {
    text: SECRET,
    truncated: false,
    gone: false,
  });
  f.outputs.set(SHELL, path.join(f.temp, "claude-4242", "slug", NATIVE, "tasks", "gone"));
  assert.equal((await f.get(output(SHELL))).body.gone, true);
});

test("a 300 KiB output returns its last 262,144 bytes", async (t) => {
  const f = await app(t, { shells: [shell(SHELL)] });
  f.outputs.set(SHELL, shellFile(f, { text: "a".repeat(300 * 1024) }));
  const { body } = await f.get(output(SHELL));
  assert.equal(Buffer.byteLength(body.text), 262144);
  assert.equal(body.truncated, true);
  assert.equal(body.gone, false);
});

test("output paths outside the session's own task folder are gone without being read", async (t) => {
  const f = await app(t, { shells: [shell(SHELL)] });
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "task-reads-other-"));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  const otherRoot = path.join(
    elsewhere,
    `claude-4242`,
    "slug",
    NATIVE,
    "tasks",
    `${SHELL}.output`,
  );
  write(otherRoot, SECRET);
  const real = shellFile(f);
  const candidates = {
    "another root": otherRoot,
    "another uid": shellFile(f, { uid: 7 }),
    "another session id": shellFile(f, {
      session: "99999999-aaaa-bbbb-cccc-dddddddddddd",
    }),
    "a dot-dot segment": `${path.join(f.temp, "claude-4242", "slug", "x")}/../${NATIVE}/tasks/${SHELL}.output`,
    "a relative path": path.relative(process.cwd(), real),
    "another task name": shellFile(f, { id: "other" }),
  };
  for (const [name, file] of Object.entries(candidates)) {
    f.outputs.set(SHELL, file);
    const { body } = await f.get(output(SHELL));
    assert.deepEqual(body, { text: "", truncated: false, gone: true }, name);
  }
});

test("a symlinked output file or folder is gone", async (t) => {
  const f = await app(t, { shells: [shell(SHELL)] });
  const target = path.join(f.root, "target.txt");
  write(target, SECRET);
  const file = path.join(
    f.temp,
    "claude-4242",
    "slug",
    NATIVE,
    "tasks",
    `${SHELL}.output`,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(target, file);
  f.outputs.set(SHELL, file);
  assert.equal((await f.get(output(SHELL))).body.gone, true);
  // A linked session folder redirects the whole path.
  const real = path.join(f.root, "real-session");
  write(path.join(real, "tasks", `${SHELL}.output`), SECRET);
  fs.rmSync(path.join(f.temp, "claude-4242", "slug", NATIVE), {
    recursive: true,
    force: true,
  });
  fs.symlinkSync(real, path.join(f.temp, "claude-4242", "slug", NATIVE));
  assert.equal((await f.get(output(SHELL))).body.gone, true);
});

function codexThreads(threads) {
  return {
    codexRequest: async (_session, run) =>
      run({
        request: async (method, params) => {
          const thread = threads[params.threadId];
          if (!thread) throw problem("Unknown thread", 404);
          return { thread: method === "thread/read" ? thread : undefined };
        },
      }),
  };
}

const codexChild = (parent, extra = {}) => ({
  id: "child1",
  cwd: "/work",
  parentThreadId: parent,
  turns: [
    {
      id: "turn1",
      items: [{ type: "userMessage", id: "i1", content: [{ type: "text", text: "go" }] }],
    },
  ],
  ...extra,
});

test("a Codex child is read when its parent chain reaches the session thread", async (t) => {
  const threads = {
    child1: codexChild("mid1"),
    mid1: { id: "mid1", cwd: "/work", parentThreadId: NATIVE },
  };
  const f = await app(t, {
    tool: "codex",
    subagents: [subagent("child1", "running")],
    history: codexThreads(threads),
  });
  const { status, body } = await f.get(transcript("child1"));
  assert.equal(status, 200);
  assert.equal(body.partial, true);
  assert.equal(body.messages[0].text, "go");
});

test("a Codex child whose parent chain misses the session thread answers 404", async (t) => {
  const threads = {
    child1: codexChild("mid1"),
    mid1: { id: "mid1", cwd: "/work", parentThreadId: "other-root" },
    "other-root": { id: "other-root", cwd: "/work" },
  };
  const f = await app(t, {
    tool: "codex",
    subagents: [subagent("child1")],
    history: codexThreads(threads),
  });
  assert.equal((await f.get(transcript("child1"))).status, 404);
});

test("an OpenCode child session needs the session as its parent", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "task-reads-oc-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const data = path.join(home, "data");
  fs.mkdirSync(path.join(data, "opencode"), { recursive: true });
  const db = new DatabaseSync(path.join(data, "opencode", "opencode.db"));
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER, revert TEXT, parent_id TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE INDEX message_session_time_created_id_idx ON message(session_id,time_created,id);
    CREATE TABLE part(id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT);
    CREATE INDEX part_message_id_id_idx ON part(message_id,id);
    CREATE TABLE todo(session_id TEXT, content TEXT, status TEXT, priority TEXT, position INTEGER);
  `);
  const insert = db.prepare("INSERT INTO session VALUES (?, ?, ?, NULL, ?)");
  insert.run("ses_own", "/work", 1, NATIVE);
  insert.run("ses_foreign", "/work", 1, "ses_somebody_else");
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
    "msg_1",
    "ses_own",
    1,
    JSON.stringify({ role: "user", time: { created: 1 } }),
  );
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run(
    "msg_1_p1",
    "ses_own",
    "msg_1",
    JSON.stringify({ type: "text", text: "child says hi" }),
  );
  const f = await app(t, {
    tool: "opencode",
    subagents: [subagent("ses_own"), subagent("ses_foreign")],
    history: {
      home,
      environment: () => ({ HOME: home, XDG_DATA_HOME: data }),
    },
  });
  const ok = await f.get(transcript("ses_own"));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.messages[0].text, "child says hi");
  assert.equal(ok.body.partial, false);
  assert.equal((await f.get(transcript("ses_foreign"))).status, 404);
});

test("a temp root that is a link serves paths reported under either spelling", async (t) => {
  const f = await app(t, { shells: [shell(SHELL)] });
  // The system temp folder may itself sit behind a link (/var on macOS).
  const real = path.join(fs.realpathSync(f.root), "real-tmp");
  const link = path.join(f.root, "link-tmp");
  const tail = path.join("claude-4242", "slug", NATIVE, "tasks", `${SHELL}.output`);
  write(path.join(real, tail), SECRET);
  fs.symlinkSync(real, link);
  const reads = new TaskReads({
    sessions: { get: async () => ({ id: "s1" }) },
    chat: {
      read: async () => ({
        providerSessionId: NATIVE,
        observability: { shells: [shell(SHELL)] },
      }),
      shellOutputFile: () => f.outputs.get(SHELL),
    },
    uid: 4242,
    tempRoots: [link],
    history: {},
  });
  for (const reported of [path.join(real, tail), path.join(link, tail)]) {
    f.outputs.set(SHELL, reported);
    assert.deepEqual(await reads.output("s1", SHELL), {
      text: SECRET,
      truncated: false,
      gone: false,
    });
  }
});

test("a Codex child with paginated turns is read through the paging fallback", async (t) => {
  const calls = [];
  const item = codexChild(NATIVE).turns[0].items[0];
  const history = {
    codexRequest: async (_session, run) =>
      run({
        request: async (method, params) => {
          calls.push(method);
          if (method === "thread/turns/list")
            return params.cursor
              ? { data: [{ id: "t1", items: [item] }] }
              : { data: [{ id: "t2", items: [] }], nextCursor: "c1" };
          if (params.includeTurns) throw problem("Paginated", 409);
          return { thread: codexChild(NATIVE, { turns: undefined }) };
        },
      }),
  };
  const f = await app(t, { tool: "codex", subagents: [subagent("child1")], history });
  const { status, body } = await f.get(transcript("child1"));
  assert.equal(status, 200);
  assert.equal(body.messages[0].text, "go");
  assert.equal(calls.filter((m) => m === "thread/turns/list").length, 2);
});
