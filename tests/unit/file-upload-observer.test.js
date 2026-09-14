import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { FileJobClient } from "../../web/features/files/file-job-client.js";

const job = (id, extra = {}) => ({
  id,
  scopeId: "scope",
  kind: "upload",
  status: "completed",
  ...extra,
});
function fixture() {
  const rows = Array.from({ length: 405 }, (_, n) => ({
    id: `entry-${n}`,
    type: n === 404 ? "directory" : "file",
  }));
  let children = rows.map((row, n) => ({
    entryId: row.id,
    job: job(`child-${n}`, { kind: row.type === "file" ? "upload" : "create_directory" }),
  }));
  const calls = [],
    timers = new Map();
  const controls = { fail: false, delayed: null };
  const group = job("group", { kind: "upload_group", status: "running" });
  const client = {
    async get(suffix, query, signal) {
      calls.push({ suffix, query, signal });
      if (suffix === "/jobs") return { jobs: [], nextCursor: null };
      if (suffix === "/jobs/group") return group;
      const offset = query.cursor ? Number(query.cursor.slice(7)) : 0;
      if (suffix.endsWith("/entries"))
        return {
          entries: rows.slice(offset, offset + 200),
          nextCursor: offset + 200 < rows.length ? `opaque:${offset + 200}` : null,
        };
      if (suffix.endsWith("/upload-children")) {
        if (controls.delayed) await controls.delayed.promise;
        if (controls.fail && offset) throw new Error("lost second page");
        return {
          children: children.slice(offset, offset + 200),
          nextCursor: controls.cycle
            ? "opaque:200"
            : offset + 200 < children.length
              ? `opaque:${offset + 200}`
              : null,
        };
      }
      throw new Error(`unexpected per-child request: ${suffix}`);
    },
  };
  const session = new FileJobClient(client, {
    hidden: () => false,
    listen: () => () => {},
    timer: (callback, delay) => {
      timers.set(1, { callback, delay });
      return 1;
    },
    clear: (id) => timers.delete(id),
  });
  const unsubscribe = session.subscribe(() => {});
  return {
    session,
    rows,
    calls,
    controls,
    timers,
    unsubscribe,
    replace: (value) => {
      children = value;
    },
    children: () => children,
  };
}

test("selected-group live sweeps share four pages and only complete sweeps evict unseen children", async () => {
  const f = fixture();
  try {
    await f.session.uploads.load("scope", "group", 50000);
    assert.equal(Object.keys(f.session.state.children.group).length, 405);
    assert.equal(f.session.tracked.size, 1);
    f.replace(f.children().slice(1));
    f.children()[0] = {
      entryId: "entry-1",
      job: job("new-current", { status: "running" }),
    };
    f.controls.fail = true;
    await assert.rejects(
      f.session.enqueue(async (signal, owns) => {
        await f.session.uploads.read("group", signal, owns);
        await f.session.uploads.read("group", signal, owns);
      }),
    );
    assert.equal(f.session.state.children.group["entry-1"].id, "new-current");
    assert.ok(f.session.state.children.group["entry-0"]);
    f.controls.fail = false;
    const before = f.calls.length;
    await f.session.refresh();
    assert.equal(
      f.calls
        .slice(before)
        .filter((call) => /\/(entries|upload-children)$/.test(call.suffix)).length,
      4,
    );
    for (let n = 0; n < 3; n++) await f.session.refresh();
    assert.equal(f.session.state.children.group["entry-0"], undefined);
    assert.equal(f.session.state.children.group["entry-1"].id, "new-current");
    assert.equal(f.session.tracked.size, 1);
    await tick();
    assert.equal(f.timers.size, 1);
  } finally {
    f.unsubscribe();
  }
});

test("scope disposal fences delayed child pages and a different selection keeps its own controls", async () => {
  const f = fixture();
  await f.session.uploads.load("scope", "group", 50000);
  f.session.uploads.select("different-group");
  f.replace([{ entryId: "entry-0", job: job("replacement") }]);
  const gate = Promise.withResolvers();
  f.controls.delayed = gate;
  const pending = f.session.enqueue((signal, owns) =>
    f.session.uploads.read("group", signal, owns),
  );
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await tick();
  f.unsubscribe();
  assert.equal(f.calls.at(-1).signal.aborted, true);
  gate.resolve();
  await rejected;
  assert.equal(f.session.state.children.group["entry-0"].id, "child-0");
  assert.equal(f.session.state.uploadGroupId, "different-group");
  assert.equal(f.timers.size, 0);
});

test("untrusted scope, kind, missing manifest membership and cyclic cursors fail closed", async () => {
  for (const child of [
    { entryId: "entry-0", job: job("wrong", { scopeId: "other" }) },
    { entryId: "entry-0", job: job("wrong", { kind: "create_directory" }) },
    { entryId: "unassigned", job: job("wrong") },
  ]) {
    const f = fixture();
    f.replace([child]);
    await assert.rejects(f.session.uploads.load("scope", "group", 50000), {
      code: "FILE_INVALID_RESPONSE",
    });
    assert.equal(f.session.state.children.group, undefined);
    f.unsubscribe();
  }
  const cyclic = fixture();
  cyclic.controls.cycle = true;
  await assert.rejects(cyclic.session.uploads.load("scope", "group", 50000), {
    code: "FILE_INVALID_RESPONSE",
  });
  cyclic.unsubscribe();
});

test("unselected terminal watches retire, preserve cache and restart from page one while live local children stay observed", async () => {
  const calls = [],
    current = new Map(
      ["old", "selected"].map((id) => [id, job(id, { kind: "upload_group" })]),
    );
  const session = new FileJobClient(
    {
      get: async (suffix, query) => {
        calls.push({ suffix, cursor: query.cursor });
        if (suffix === "/jobs") return { jobs: [], nextCursor: null };
        if (suffix.endsWith("/entries"))
          return { entries: [{ id: "file", type: "file" }], nextCursor: null };
        if (suffix.endsWith("/upload-children"))
          return {
            children: [{ entryId: "file", job: job("cached-child") }],
            nextCursor: null,
          };
        return current.get(suffix.split("/").at(-1));
      },
      mutate: async () => {
        const child = job("local-child", { status: "running" });
        current.set(child.id, child);
        return { uploadId: child.id, job: child };
      },
    },
    { hidden: () => false, listen: () => () => {}, timer: () => 1, clear() {} },
  );
  const stop = session.subscribe(() => {});
  try {
    await session.uploads.load("scope", "old", 50000);
    await session.uploads.load("scope", "selected", 50000);
    session.uploads.select("selected");
    calls.length = 0;
    await session.refresh();
    await session.refresh();
    assert.equal(
      calls.filter((call) => call.suffix === "/jobs/old/upload-children").length,
      0,
    );
    assert.equal(session.state.children.old.file.id, "cached-child");
    session.uploads.select("old");
    calls.length = 0;
    await session.refresh();
    assert.equal(
      calls.find((call) => call.suffix === "/jobs/old/upload-children").cursor,
      null,
    );
    session.uploads.select("selected");
    await session.uploads.request(
      "scope",
      "/uploads",
      { groupId: "old", entryId: "file" },
      "child",
    );
    calls.length = 0;
    await session.refresh();
    assert.ok(calls.some((call) => call.suffix === "/jobs/old/upload-children"));
    current.get("local-child").status = "completed";
    await session.refresh();
    calls.length = 0;
    await session.refresh();
    assert.equal(
      calls.filter((call) => call.suffix === "/jobs/old/upload-children").length,
      0,
    );
  } finally {
    stop();
  }
});
