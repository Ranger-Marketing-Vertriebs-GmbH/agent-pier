import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { FileUploadClient } from "../../web/features/files/file-upload-client.js";

const limits = { jobEntries: 50000, maxDepth: 128, uploadBytes: 1000, jobBytes: 10000 };
const row = (id, extra = {}) => ({
  id,
  relativePath: `${id}.txt`,
  path: `/target/${id}.txt`,
  type: "file",
  bytes: 1,
  status: "failed",
  ...extra,
});
function fixture() {
  const state = { jobs: [], entries: {}, children: {} },
    calls = [];
  const jobs = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    selectUploadGroup: () => {},
    cancel: async (_, id) => calls.push({ cancel: id }),
    uploadRequest: async (_, suffix, body) => {
      calls.push({ suffix, body });
      return { uploadId: "actual-child", job: { id: "actual-child", status: "queued" } };
    },
  };
  const owner = new FileUploadClient({}, "scope", jobs, limits, false);
  const unsubscribe = owner.subscribe(() => {});
  const group = owner.makeGroup("/target");
  Object.assign(group, { serverId: "group", phase: "active", autoplay: false });
  owner.groups.push(group);
  state.children.group = {};
  const add = (value, phase = "failed") => {
    group.rows.push(value);
    group.files.set(value.relativePath, new File(["x"], value.relativePath));
    const attempt = { ...owner.attempt(), phase };
    group.attempts.set(value.id, attempt);
    return attempt;
  };
  return { owner, group, state, calls, add, unsubscribe };
}

test("uncertain reservation replay shares the three-slot admission bound", async () => {
  const f = fixture();
  for (let n = 0; n < 3; n++) f.add(row(`busy${n}`), "sending");
  const waiting = row("retry"),
    attempt = f.add(waiting, "reservation_unknown");
  attempt.body = { requestId: "immutable-request" };
  f.owner.retry(f.group, waiting.id);
  await tick();
  assert.equal(f.calls.length, 0);
  f.group.attempts.get("busy0").phase = "completed";
  f.owner.send = () => {};
  f.owner.pump();
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body, attempt.body);
  f.unsubscribe();
});

test("explicit retry reserves before ancestor readiness and waits for its current remap", async () => {
  const f = fixture();
  const parent = row("parent", {
    relativePath: "root",
    path: "/target/root",
    type: "directory",
    status: "failed",
  });
  const child = row("file", {
    relativePath: "root/file.txt",
    path: "/target/root/file.txt",
  });
  f.group.rows.push(parent);
  const prior = f.add(child);
  prior.uploadId = "failed-child";
  prior.job = { id: "failed-child", status: "failed" };
  f.state.children.group.file = prior.job;
  const sent = [];
  f.owner.send = (_, current) => sent.push(current.path);
  f.owner.retry(f.group, child.id);
  await tick();
  assert.equal(f.calls[0].suffix, "/uploads");
  assert.equal(f.group.attempts.get(child.id).uploadId, "actual-child");
  assert.deepEqual(sent, []);
  parent.status = "completed";
  parent.path = "/target/root (2)";
  f.owner.sync();
  assert.deepEqual(sent, []);
  child.path = "/target/root (2)/file.txt";
  f.owner.sync();
  assert.deepEqual(sent, [child.path]);
  assert.equal(f.calls.length, 1);
  f.unsubscribe();
});

test("rendered cancellation keeps its captured child instead of retargeting a replacement", async () => {
  const f = fixture(),
    entry = row("file");
  f.group.rows.push(entry);
  const captured = { attempt: undefined, childId: "old-child" };
  f.state.children.group.file = { id: "new-child", status: "running" };
  await f.owner.cancel(f.group, entry.id, captured);
  assert.deepEqual(f.calls, [{ cancel: "old-child" }]);
  f.unsubscribe();
});

test("null child details do not authorize a new retry and current-render ownership fences old actions", async () => {
  const f = fixture(),
    entry = row("file", { status: "running" });
  f.group.rows.push(entry);
  f.group.files.set(entry.relativePath, new File(["x"], "file.txt"));
  f.state.children.group.file = null;
  f.owner.retry(f.group, entry.id);
  await tick();
  assert.equal(f.calls.length, 0);
  f.owner.isCurrent = () => false;
  await f.owner.cancel(f.group);
  assert.equal(f.calls.length, 0);
  f.unsubscribe();
});

test("pruned failed/interrupted child metadata still permits explicit reselection for backend retry admission", async () => {
  for (const status of ["failed", "interrupted"]) {
    const f = fixture(),
      entry = row("file", { status });
    f.group.rows.push(entry);
    f.state.children.group.file = null;
    f.owner.send = () => {};
    f.owner.retry(f.group, entry.id);
    assert.equal(f.calls.length, 0);
    await f.owner.reselect([new File(["x"], "file.txt")], f.group);
    await tick();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].body.entryId, entry.id);
    f.unsubscribe();
  }
});

test("cancelled collection and late selection release Files without creating metadata", async () => {
  for (const dispose of [false, true]) {
    const f = fixture(),
      delayed = Promise.withResolvers();
    const input = {
      items: [
        {
          kind: "file",
          webkitGetAsEntry: () => ({
            name: "late.txt",
            isFile: true,
            file: (done) => delayed.promise.then(done),
          }),
        },
      ],
    };
    const pending = f.owner.add(input, "/target");
    const collecting = f.owner.selected;
    if (dispose) f.unsubscribe();
    else await f.owner.cancel(collecting);
    delayed.resolve(new File(["x"], "late.txt"));
    await pending;
    assert.equal(f.calls.length, 0);
    assert.equal(collecting.files.size, 0);
    assert.equal(collecting.selection, undefined);
    if (!dispose) f.unsubscribe();
  }
});

test("invalid selection limits retain no unusable File references", async () => {
  const f = fixture();
  await f.owner.add([new File(["x".repeat(1001)], "large.txt")], "/target");
  assert.equal(f.owner.selected.error.code, "FILE_LIMIT_EXCEEDED");
  assert.equal(f.owner.selected.files.size, 0);
  assert.equal(f.owner.selected.selection, undefined);
  assert.equal(f.calls.length, 0);
  f.unsubscribe();
});

test("native selection DOMException codes produce a visible translated failure", async () => {
  const f = fixture();
  await f.owner.add(
    {
      items: [
        {
          kind: "file",
          webkitGetAsEntry: () => ({
            name: "missing.txt",
            isFile: true,
            file: (_, reject) =>
              reject(new DOMException("Path does not exist", "NotFoundError")),
          }),
        },
      ],
    },
    "/target",
  );
  assert.equal(f.owner.selected.error.code, "FILE_IO_ERROR");
  assert.equal(typeof f.owner.selected.error.message, "string");
  assert.equal(f.calls.length, 0);
  f.unsubscribe();
});

test("cancelling or disposing a stalled directory read releases its pending selection", async () => {
  for (const dispose of [false, true]) {
    const f = fixture();
    let returned = false;
    const input = {
      items: [
        {
          kind: "file",
          webkitGetAsEntry: () => ({
            name: "waiting",
            isDirectory: true,
            createReader: () => ({ readEntries() {} }),
          }),
        },
      ],
    };
    const pending = f.owner.add(input, "/target").then(() => {
      returned = true;
    });
    if (dispose) f.unsubscribe();
    else await f.owner.cancel(f.owner.selected);
    await tick();
    assert.equal(returned, true);
    await pending;
    assert.equal(f.calls.length, 0);
    if (!dispose) f.unsubscribe();
  }
});
