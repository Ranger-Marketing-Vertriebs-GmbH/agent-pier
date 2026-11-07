import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { signedInUser } from "../helpers/users.js";

const timeout = 30000;
const VIDEO_BYTES = 30 * 1024 * 1024;
const unavailableKey = "agentPinboard.pinboardUnavailable";

// An MP4 container head (ftyp isom) followed by some payload bytes.
const mp4Head = () => {
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write("ftypisom", 4, "latin1");
  ftyp.write("isommp41", 16, "latin1");
  return Buffer.concat([ftyp, Buffer.alloc(4000, 7)]);
};

/**
 * The real app with the agent feature on and one agent; its pinboard is seeded
 * through the production instance (graph.assistants.pinboard) and the agent's
 * workspace. `pin(path, options)` adds an entry to a list, creating it once.
 */
async function fixture(t) {
  const f = await applicationFixture(t, enabledAssistants);
  const service = f.application.assistants;
  assert.ok(service?.pinboard, "the pinboard is wired");
  const agent = service.store.createAssistant({
    name: "Writer",
    model: { connectionId: "c", modelId: "m" },
  });
  const store = service.pinboard.store;
  const workspace = path.join(service.attachments.config.workspaces, agent.id);
  const file = (name, body = "# Draft\n") => {
    const target = path.join(workspace, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    return target;
  };
  const lists = new Map();
  const list = (title, archived = false) => {
    if (!lists.has(title)) {
      const now = new Date().toISOString();
      const created = store.createList(agent.id, { title }, now);
      if (archived) store.setArchived(agent.id, created.id, true, now);
      lists.set(title, created.id);
    }
    return lists.get(title);
  };
  const pin = (relative, { title = "Episodes", root = "workspace", name } = {}) =>
    store.pin(
      agent.id,
      list(title),
      {
        name: name ?? path.basename(relative),
        note: "",
        root,
        path: relative,
        admitConversationId: null,
        identity: null,
      },
      new Date().toISOString(),
    ).entry;
  const base = `/api/assistants/${agent.id}/pinboard`;
  const view = async (headers) => {
    const response = await f.request(base, { headers });
    assert.equal(response.status, 200);
    return response.json();
  };
  const fileOf = (entry, { query = "", ...options } = {}) =>
    f.request(`${base}/entries/${entry.id}/file${query}`, options);
  return { ...f, service, agent, store, workspace, file, list, pin, base, view, fileOf };
}

const entryState = (board, id) =>
  board.lists.flatMap((list) => list.entries).find((entry) => entry.id === id);

test("the view lists open lists first and counts NEW entries", { timeout }, async (t) => {
  const f = await fixture(t);
  f.file("out/old.md", "old");
  f.file("out/ep6.md", "# Episode 6\n");
  f.file("out/ep7.md", "# Episode 7\n");
  f.list("Archive", true);
  f.pin("out/old.md", { title: "Archive" });
  f.pin("out/ep6.md");
  f.pin("out/ep7.md");
  const board = await f.view();
  assert.deepEqual(
    board.lists.map((list) => [list.title, list.archived]),
    [
      ["Episodes", false],
      ["Archive", true],
    ],
  );
  assert.equal(board.fresh, 2);
  assert.deepEqual(
    board.lists[0].entries.map((entry) => [entry.name, entry.state, entry.fresh]),
    [
      ["ep6.md", "ok", true],
      ["ep7.md", "ok", true],
    ],
  );
  const response = await f.request(f.base);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("a video beyond 25 MiB streams with ranges", { timeout }, async (t) => {
  const f = await fixture(t);
  const target = f.file("out/cut.mp4", mp4Head());
  fs.truncateSync(target, VIDEO_BYTES);
  const entry = f.pin("out/cut.mp4");
  const first = await f.fileOf(entry, { headers: { range: "bytes=0-99" } });
  assert.equal(first.status, 206);
  assert.equal(first.headers.get("content-range"), `bytes 0-99/${VIDEO_BYTES}`);
  assert.equal(first.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    first.headers.get("content-security-policy"),
    "default-src 'none'; sandbox",
  );
  assert.equal(first.headers.get("cache-control"), "private, no-store");
  const head = Buffer.from(await first.arrayBuffer());
  assert.equal(head.length, 100);
  assert.equal(head.subarray(4, 12).toString("latin1"), "ftypisom");
  // An open-ended range, as a player asks first; the body is not read here.
  const open = await f.fileOf(entry, { headers: { range: "bytes=0-" } });
  assert.equal(open.status, 206);
  assert.equal(
    open.headers.get("content-range"),
    `bytes 0-${VIDEO_BYTES - 1}/${VIDEO_BYTES}`,
  );
  await open.body.cancel();
  const seek = await f.fileOf(entry, {
    headers: { range: `bytes=${VIDEO_BYTES - 10}-` },
  });
  assert.equal(seek.status, 206);
  assert.equal(Buffer.from(await seek.arrayBuffer()).length, 10);
  const headed = await f.fileOf(entry, { method: "HEAD" });
  assert.equal(headed.status, 200);
  assert.equal(headed.headers.get("content-length"), String(VIDEO_BYTES));
  assert.equal(headed.headers.get("accept-ranges"), "bytes");
  assert.equal((await headed.arrayBuffer()).byteLength, 0);
  const whole = await f.fileOf(entry);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-length"), String(VIDEO_BYTES));
  assert.equal((await whole.arrayBuffer()).byteLength, VIDEO_BYTES);
});

test("a link swapped in after pinning is refused", { timeout }, async (t) => {
  const f = await fixture(t);
  const secret = "OUTSIDE-SECRET-BYTES";
  const outside = path.join(f.root, "outside.txt");
  fs.writeFileSync(outside, secret);
  const target = f.file("out/ep6.md");
  const entry = f.pin("out/ep6.md");
  assert.equal((await f.fileOf(entry)).status, 200);
  fs.rmSync(target);
  fs.symlinkSync(outside, target);
  const response = await f.fileOf(entry);
  assert.equal(response.status, 404);
  const text = await response.text();
  assert.ok(!text.includes(secret));
  assert.equal(JSON.parse(text).messageKey, unavailableKey);
  // A folder on the way swapped for a link as well.
  const folder = path.join(f.root, "elsewhere");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "ep7.md"), secret);
  f.file("drafts/ep7.md");
  const nested = f.pin("drafts/ep7.md");
  fs.rmSync(path.join(f.workspace, "drafts"), { recursive: true });
  fs.symlinkSync(folder, path.join(f.workspace, "drafts"));
  const swapped = await f.fileOf(nested, { headers: { range: "bytes=0-" } });
  assert.equal(swapped.status, 404);
  assert.ok(!(await swapped.text()).includes(secret));
  const board = await f.view();
  assert.equal(entryState(board, entry.id).state, "unavailable");
  assert.equal(entryState(board, nested.id).state, "unavailable");
});

test(
  "a revoked project grant makes the entry unavailable until regranted",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const registered = await f.request("/api/memory/projects", {
      method: "POST",
      body: { cwd: f.project },
    });
    assert.equal(registered.status, 201);
    const project = await registered.json();
    let current = { coding: false, folder: "none" };
    const grant = async (folder) => {
      const next = { coding: folder !== "none", folder };
      const response = await f.request(
        `/api/assistant-project-access/${project.id}/${f.agent.id}`,
        { method: "PUT", body: { expected: current, ...next } },
      );
      assert.equal(response.status, 200, await response.clone().text());
      current = next;
    };
    await grant("read");
    fs.mkdirSync(path.join(f.project, "docs"));
    fs.writeFileSync(path.join(f.project, "docs/plan.md"), "# Plan\n");
    const entry = f.pin("docs/plan.md", { root: `project:${project.id}` });
    assert.equal((await f.fileOf(entry)).status, 200);
    await grant("none");
    assert.equal(entryState(await f.view(), entry.id).state, "unavailable");
    const refused = await f.fileOf(entry);
    assert.equal(refused.status, 404);
    assert.equal((await refused.json()).messageKey, unavailableKey);
    await grant("read");
    assert.equal(entryState(await f.view(), entry.id).state, "ok");
    const served = await f.fileOf(entry);
    assert.equal(served.status, 200);
    assert.equal(await served.text(), "# Plan\n");
  },
);

test("seen clears NEW", { timeout }, async (t) => {
  const f = await fixture(t);
  f.file("out/ep6.md");
  const entry = f.pin("out/ep6.md");
  assert.equal((await f.view()).fresh, 1);
  const seen = await f.request(`${f.base}/entries/${entry.id}/seen`, { method: "POST" });
  assert.equal(seen.status, 204);
  const board = await f.view();
  assert.equal(board.fresh, 0);
  assert.equal(entryState(board, entry.id).fresh, false);
  // An entry that is not there is not found.
  const missing = await f.request(`${f.base}/entries/nope/seen`, { method: "POST" });
  assert.equal(missing.status, 404);
});

test("a restricted user gets not found", { timeout }, async (t) => {
  const f = await fixture(t);
  f.file("out/ep6.md", "private draft");
  const entry = f.pin("out/ep6.md");
  const { cookie } = await signedInUser(f);
  const headers = { cookie };
  assert.equal((await f.request(f.base, { headers })).status, 404);
  const file = await f.fileOf(entry, { headers });
  assert.equal(file.status, 404);
  assert.ok(!(await file.text()).includes("private draft"));
  const seen = await f.request(`${f.base}/entries/${entry.id}/seen`, {
    method: "POST",
    headers,
  });
  assert.equal(seen.status, 404);
  assert.equal((await f.view()).fresh, 1);
});

test("downloads carry the file name", { timeout }, async (t) => {
  const f = await fixture(t);
  f.file("out/ep6.md", "# Episode 6\n");
  const entry = f.pin("out/ep6.md");
  const response = await f.fileOf(entry, { query: "?download=1" });
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-disposition"),
    "attachment; filename*=UTF-8''ep6.md",
  );
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(await response.text(), "# Episode 6\n");
});

test("every route answers 503 while the agents are away", { timeout }, async (t) => {
  const f = await fixture(t);
  f.file("out/ep6.md");
  const entry = f.pin("out/ep6.md");
  const routes = () => [
    f.request(f.base),
    f.fileOf(entry),
    f.request(`${f.base}/entries/${entry.id}/seen`, { method: "POST" }),
  ];
  // During maintenance the app's write guard answers a write first ("active").
  const expected = {
    maintenance: [503, 503, 409],
    recovering: [503, 503, 503],
    closed: [503, 503, 503],
  };
  for (const state of Object.keys(expected)) {
    f.service[state] = true;
    try {
      const statuses = (await Promise.all(routes())).map((r) => r.status);
      assert.deepEqual(statuses, expected[state], state);
    } finally {
      f.service[state] = false;
    }
  }
  assert.equal((await f.view()).fresh, 1);
});

test("a user's own agent is not found without her opt-in", { timeout }, async (t) => {
  const f = await fixture(t);
  f.file("out/ep6.md", "her draft");
  const entry = f.pin("out/ep6.md");
  const body = {
    ...f.service.store.storedAssistant(f.agent.id),
    userAccess: {
      mode: "own",
      members: [{ userId: "anna", level: "chat" }],
      released: [],
    },
  };
  f.service.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.agent.id);
  assert.equal((await f.request(f.base)).status, 404);
  const file = await f.fileOf(entry);
  assert.equal(file.status, 404);
  assert.ok(!(await file.text()).includes("her draft"));
  const seen = await f.request(`${f.base}/entries/${entry.id}/seen`, { method: "POST" });
  assert.equal(seen.status, 404);
  assert.equal(f.store.entry(f.agent.id, entry.id).seenIdentity, null);
});
