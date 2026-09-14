import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { FileUploadClient } from "../../web/features/files/file-upload-client.js";
import { FileUploadStore } from "../../server/features/files/file-upload-store.js";

function fixture(t) {
  const requests = [],
    calls = [],
    state = { jobs: [], entries: {}, children: { group: {} } };
  const oldXHR = globalThis.XMLHttpRequest,
    oldWindow = globalThis.window;
  class XHR {
    constructor() {
      this.upload = {};
      requests.push(this);
    }
    open() {}
    setRequestHeader() {}
    send(file) {
      this.file = file;
      this.active = true;
    }
    abort() {
      this.aborted = true;
      this.active = false;
      this.onabort?.();
    }
    respond(status, body) {
      this.active = false;
      this.status = status;
      this.responseText = JSON.stringify(body);
      this.onload();
    }
  }
  globalThis.XMLHttpRequest = XHR;
  globalThis.window = new EventTarget();
  t.after(() => {
    if (oldXHR === undefined) delete globalThis.XMLHttpRequest;
    else globalThis.XMLHttpRequest = oldXHR;
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  });
  const jobs = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    cancel: async (_, id) => calls.push({ cancel: id }),
    inspect: async (_, id) =>
      state.jobs.find((job) => job.id === id) || { id, status: "running" },
    uploadRequest: async (_, suffix, body) => {
      calls.push({ suffix, body });
      if (body.entryId === "0")
        throw Object.assign(new Error(), { code: "FILE_UPLOAD_PENDING", status: 409 });
      const job = { id: `child-${body.entryId}`, status: "queued" };
      state.jobs.push(job);
      return { uploadId: job.id, job };
    },
  };
  const owner = new FileUploadClient(
    { base: "/api/files" },
    "scope",
    jobs,
    { jobEntries: 50000, maxDepth: 128 },
    false,
  );
  const stop = owner.subscribe(() => {});
  t.after(stop);
  const group = owner.makeGroup("/target");
  Object.assign(group, { serverId: "group", phase: "active", autoplay: false });
  owner.groups.push(group);
  const add = (id, phase = "waiting") => {
    const row = {
      id,
      relativePath: `${id}.txt`,
      path: `/target/${id}.txt`,
      type: "file",
      bytes: 1,
      status: "ready",
    };
    const file = new File(["x"], row.relativePath);
    group.rows.push(row);
    group.files.set(row.relativePath, file);
    const attempt = {
      ...owner.attempt(),
      phase,
      ...(phase === "waiting"
        ? { uploadId: `live-${id}`, job: { id: `live-${id}`, status: "running" } }
        : {}),
    };
    group.attempts.set(id, attempt);
    return { row, attempt, file };
  };
  return { owner, group, jobs, state, calls, requests, stop, add };
}

test("render ownership loss before cleanup fences global XHR auth while current 401 still dispatches", async (t) => {
  const f = fixture(t);
  let events = 0;
  window.addEventListener("agentpier-login-required", () => events++);
  for (const current of [false, true]) {
    f.owner.isCurrent = () => true;
    const { row, attempt } = f.add(String(current));
    const pending = f.owner.send(f.group, row, attempt);
    f.owner.isCurrent = () => current;
    const xhr = f.requests.at(-1);
    xhr.upload.onprogress({ loaded: 1, total: 1, lengthComputable: true });
    xhr.respond(401, { code: "FILE_ACCESS_DENIED" });
    await pending;
    assert.equal(events, current ? 1 : 0);
    assert.equal(attempt.loaded, current ? 1 : 0);
    assert.equal(xhr.onload, null);
  }
});

test("stale unstarted cancellation cannot displace three live XHRs or lose disposal ownership", async (t) => {
  const f = fixture(t),
    pending = [];
  for (let n = 0; n < 4; n++) {
    const { row, attempt } = f.add(String(n), n < 3 ? "waiting" : "new");
    if (n < 3) pending.push(f.owner.send(f.group, row, attempt));
  }
  const original = f.group.attempts.get("0");
  await f.owner.cancel(f.group, "0", { attempt: undefined, childId: undefined });
  await tick();
  f.owner.sync();
  await tick();
  assert.equal(f.group.attempts.get("0"), original);
  assert.equal(f.requests.filter((xhr) => xhr.active).length, 3);
  assert.equal(f.calls.length, 0);
  f.stop();
  await Promise.all(pending);
  assert.equal(
    f.requests.every((xhr) => xhr.aborted),
    true,
  );
});

test("a real producer's conclusive stale-path refusal permits one explicit refreshed claim and body", async (t) => {
  const f = fixture(t),
    selected = f.add("file", "new");
  const directory = {
    id: "dir",
    relativePath: "root",
    path: "/target/root",
    type: "directory",
    bytes: 0,
    status: "pending",
  };
  Object.assign(selected.row, {
    relativePath: "root/file",
    path: "/target/root/file",
    status: "pending",
  });
  f.group.files.clear();
  f.group.files.set(selected.row.relativePath, selected.file);
  f.group.rows.unshift(directory);
  let durableRow = { ...selected.row },
    refreshes = 0,
    admitted = 0;
  const journal = {
    group: () => ({ committed: true }),
    save() {},
    touch() {},
    assertRetryable: FileUploadStore.prototype.assertRetryable,
    rowByPath: () => directory,
    store: {
      getEntry: () => durableRow,
      getJob: () => ({ status: "queued", completedBytes: 0 }),
      putEntry: (id, row) => {
        if (id === "group") durableRow = row;
      },
      transition() {},
      now: () => 1,
    },
  };
  f.jobs.uploadRequest = async (_, suffix, body) => {
    f.calls.push({ suffix, body });
    if (f.calls.length === 1) {
      directory.status = "completed";
      directory.path = "/target/root (2)";
      durableRow = { ...durableRow, path: "/target/root (2)/file", status: "ready" };
    }
    FileUploadStore.prototype.claim.call(journal, { id: "scope" }, "actual-child", {
      parentJobId: body.groupId,
      entryId: body.entryId,
      target: body.path,
      name: body.name,
      options: { bytes: body.bytes },
    });
    admitted++;
    return { uploadId: "actual-child", job: { id: "actual-child", status: "queued" } };
  };
  f.jobs.loadUploadGroup = async () => {
    refreshes++;
    const rows = [{ ...directory }, { ...durableRow }];
    f.state.entries.group = { entries: rows };
    return rows;
  };
  f.owner.pump();
  await tick();
  assert.equal(selected.attempt.error.code, "FILE_INVALID_OPERATION");
  assert.equal(admitted, 0);
  assert.equal(f.requests.length, 0);
  f.owner.retry(f.group, selected.row.id);
  await tick();
  assert.equal(refreshes, 1);
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[0].body.requestId, f.calls[1].body.requestId);
  assert.equal(f.calls[1].body.path, "/target/root (2)");
  assert.equal(admitted, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].file, selected.file);
  f.state.jobs.push({ id: "actual-child", status: "completed" });
  f.requests[0].respond(200, {
    id: "actual-child",
    kind: "upload",
    scopeId: "scope",
    status: "completed",
  });
  await tick();
  f.owner.retry(f.group, selected.row.id);
  await tick();
  assert.equal(f.requests.length, 1);
  assert.equal(f.calls.length, 2);
});

test("refused retry refreshes are singular, retain refusal on read failure and cannot admit after cancellation", async (t) => {
  const f = fixture(t),
    { row, attempt } = f.add("file", "failed"),
    body = Object.freeze({ requestId: "refused-request" });
  Object.assign(attempt, { body, refused: true });
  let gate = Promise.withResolvers(),
    reads = 0;
  f.jobs.loadUploadGroup = () => {
    reads++;
    return gate.promise;
  };
  f.owner.retry(f.group, row.id);
  f.owner.retry(f.group, row.id);
  assert.equal(reads, 1);
  gate.reject(Object.assign(new Error(), { code: "FILE_IO_ERROR", status: 500 }));
  await tick();
  assert.equal(attempt.phase, "failed");
  assert.equal(attempt.refused, true);
  assert.equal(attempt.body, body);
  assert.equal(f.calls.length, 0);
  gate = Promise.withResolvers();
  f.owner.retry(f.group, row.id);
  await f.owner.cancel(f.group, row.id, { attempt, childId: undefined });
  gate.resolve([row]);
  await tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(attempt.refused, true);
  f.owner.retry(f.group, row.id);
  await tick();
  assert.equal(reads, 3);
  assert.equal(f.calls.length, 1);
  assert.notEqual(f.calls[0].body.requestId, body.requestId);
  assert.equal(f.requests.length, 1);
});
