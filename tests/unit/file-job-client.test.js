import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { FileJobClient } from "../../web/features/files/file-job-client.js";

const job = (id, extra = {}) => ({
  id,
  scopeId: "scope",
  kind: "search",
  status: "running",
  ...extra,
});

test("a complete omission review stays on the shared queue and is fenced by its client generation", async () => {
  const gate = Promise.withResolvers(),
    conflict = { id: "consent", type: "archive_links", manifestVersion: "v1" };
  let reads = 0,
    mutations = 0;
  const f = fixture({
    async get(suffix, query) {
      if (suffix === "/jobs") return { jobs: [], nextCursor: null };
      if (!suffix.endsWith("/entries"))
        return job("archive", {
          kind: "archive",
          status: "waiting_for_conflict",
          conflict,
        });
      if (++reads === 1) await gate.promise;
      return {
        entries: [
          {
            id: query.cursor ? "last" : "first",
            path: "link",
            type: "symlink",
            status: "skipped",
            manifestVersion: "v1",
          },
        ],
        nextCursor: query.cursor ? null : "page-two",
      };
    },
    async mutate() {
      mutations++;
      return job("new");
    },
  });
  await tick();
  const review = f.session.operations.omissions(
    "scope",
    job("archive", { kind: "archive", conflict }),
    50000,
  );
  const cancelled = assert.rejects(review, { name: "AbortError" });
  await tick();
  const action = f.session.start("scope", { kind: "search" });
  const actionCancelled = assert.rejects(action, { name: "AbortError" });
  await tick();
  assert.equal(mutations, 0);
  f.unsubscribe();
  gate.resolve();
  await cancelled;
  await actionCancelled;
  assert.equal(reads, 1);
  assert.equal(f.session.state.jobs.length, 0);
});

test("archive manifest replacement clears old same-ID rows and rejects continuation from another generation", async () => {
  let page = {
    entries: [
      { id: "0", manifestVersion: "v1", path: "old" },
      { id: "1", manifestVersion: "v1", path: "removed" },
    ],
    nextCursor: "next",
  };
  const f = fixture({
    get: async (suffix) => (suffix === "/jobs" ? { jobs: [], nextCursor: null } : page),
  });
  await tick();
  await f.session.refresh({ jobId: "archive", first: true });
  page = { entries: [{ id: "0", manifestVersion: "v2", path: "new" }], nextCursor: null };
  await assert.rejects(f.session.refresh({ jobId: "archive", cursor: "next" }), {
    code: "FILE_CONFLICT_CHANGED",
  });
  await f.session.refresh({ jobId: "archive", first: true });
  assert.deepEqual(
    f.session.state.entries.archive.entries.map((row) => row.path),
    ["new"],
  );
  f.unsubscribe();
});

test("ambiguous archive requests retain their immutable identity until an explicit confirmed replay", async () => {
  const bodies = [];
  const f = fixture({
    get: async () => ({ jobs: [], nextCursor: null }),
    async mutate(_, { body }) {
      bodies.push(structuredClone(body));
      if (bodies.length === 1) throw new TypeError("Network lost");
      return job("archive", { kind: "archive" });
    },
  });
  await tick();
  await assert.rejects(
    f.session.start("scope", {
      requestId: "original",
      kind: "archive",
      options: { output: "download" },
    }),
  );
  const [uncertain] = f.session.state.uncertain;
  assert.equal(uncertain.body.requestId, "original");
  await f.session.start("scope", uncertain.body);
  assert.deepEqual(bodies[1], bodies[0]);
  assert.deepEqual(f.session.state.uncertain, []);
  f.unsubscribe();
});
function fixture(client) {
  let hidden = false,
    visibility;
  const timers = new Map();
  let sequence = 0;
  const session = new FileJobClient(client, {
    hidden: () => hidden,
    listen: (callback) => {
      visibility = callback;
      return () => {
        visibility = null;
      };
    },
    timer: (callback, delay) => {
      const id = ++sequence;
      timers.set(id, { callback, delay });
      return id;
    },
    clear: (id) => timers.delete(id),
  });
  const unsubscribe = session.subscribe(() => {});
  return {
    session,
    unsubscribe,
    timers,
    visibility: (value) => {
      hidden = value;
      visibility();
    },
  };
}

test("polling schedules by visibility and serializes delayed reads and write actions", async () => {
  const gate = Promise.withResolvers();
  let active = 0,
    peak = 0,
    starts = 0;
  const f = fixture({
    async get(suffix) {
      active++;
      peak = Math.max(peak, active);
      if (suffix === "/jobs" && starts++ === 0) await gate.promise;
      active--;
      return { jobs: [], nextCursor: null };
    },
    async mutate(suffix, args) {
      assert.equal(active, 0);
      assert.equal(args.scopeId, "scope");
      assert.equal(suffix, "/operations");
      return job("new");
    },
  });
  await tick();
  const started = f.session.start("scope", { kind: "search" });
  f.visibility(true);
  assert.equal(peak, 1);
  gate.resolve();
  assert.equal((await started).id, "new");
  await tick();
  assert.equal([...f.timers.values()][0].delay, 10000);
  f.visibility(false);
  assert.equal([...f.timers.values()][0].delay, 1500);
  f.unsubscribe();
  assert.equal(f.timers.size, 0);
});

test("delayed start completion cannot publish after client replacement", async () => {
  const delayed = Promise.withResolvers();
  let signal;
  const old = fixture({
    get: async () => ({ jobs: [], nextCursor: null }),
    mutate: async (_, args) => {
      signal = args.signal;
      return delayed.promise;
    },
  });
  await tick();
  const pending = old.session.start("scope", { kind: "search" });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await tick();
  old.unsubscribe();
  const current = fixture({
    get: async () => ({ jobs: [job("current")], nextCursor: null }),
  });
  delayed.resolve(job("obsolete"));
  await rejected;
  await tick();
  assert.equal(signal.aborted, true);
  assert.deepEqual(
    current.session.getSnapshot().jobs.map((value) => value.id),
    ["current"],
  );
  assert.deepEqual(old.session.getSnapshot().jobs, []);
  current.unsubscribe();
});

test("new jobs survive oldest-first history pages and result cursors stay opaque", async () => {
  const calls = [];
  const f = fixture({
    async get(suffix, query) {
      calls.push({ suffix, query });
      if (suffix === "/jobs")
        return {
          jobs: Array.from({ length: 200 }, (_, id) =>
            job(`old-${id}`, { status: "completed" }),
          ),
          nextCursor: "history",
        };
      if (suffix.endsWith("/entries"))
        return {
          entries: [{ id: query.cursor ? "second" : "first", path: "a" }],
          nextCursor: query.cursor ? null : "opaque",
        };
      return job("new", { status: "completed" });
    },
    mutate: async () => job("new"),
  });
  await tick();
  await f.session.start("scope", { kind: "search" });
  await f.session.refresh();
  assert.equal(
    f.session.getSnapshot().jobs.find((value) => value.id === "new").status,
    "completed",
  );
  assert.equal(f.session.getSnapshot().entries.new.nextCursor, "opaque");
  await f.session.refresh({ jobId: "new", cursor: "opaque" });
  assert.deepEqual(
    f.session.getSnapshot().entries.new.entries.map((entry) => entry.id),
    ["first", "second"],
  );
  assert.equal(calls.at(-1).query.cursor, "opaque");
  f.unsubscribe();
});

for (const action of ["cancel", "resolve", "list", "entries"]) {
  test(`delayed ${action} responses retain their original request owner`, async () => {
    const entered = Promise.withResolvers(),
      delayed = Promise.withResolvers();
    let waiting = false,
      observedSignal;
    const old = fixture({
      async get(suffix, query, signal) {
        if (waiting && (action === "list" || action === "entries")) {
          observedSignal = signal;
          entered.resolve();
          return delayed.promise;
        }
        return { jobs: [], nextCursor: null };
      },
      async mutate(suffix, args) {
        assert.equal(args.scopeId, "scope");
        if (action === "resolve")
          assert.deepEqual(args.body, {
            conflictId: "conflict",
            decision: "skip",
            applyToRemaining: false,
          });
        observedSignal = args.signal;
        entered.resolve();
        return delayed.promise;
      },
    });
    await tick();
    waiting = true;
    const pending =
      action === "list"
        ? old.session.refresh()
        : action === "entries"
          ? old.session.refresh({ jobId: "old" })
          : action === "cancel"
            ? old.session.cancel("scope", "old")
            : old.session.resolve("scope", "old", {
                conflictId: "conflict",
                decision: "skip",
                applyToRemaining: false,
              });
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await entered.promise;
    old.unsubscribe();
    const current = fixture({ get: async () => ({ jobs: [], nextCursor: null }) });
    delayed.resolve(
      action === "list"
        ? { jobs: [job("obsolete")], nextCursor: null }
        : action === "entries"
          ? { entries: [{ id: "obsolete" }], nextCursor: null }
          : job("obsolete"),
    );
    await rejected;
    assert.equal(observedSignal.aborted, true);
    assert.deepEqual(old.session.getSnapshot().jobs, []);
    assert.deepEqual(old.session.getSnapshot().entries, {});
    assert.deepEqual(current.session.getSnapshot().jobs, []);
    current.unsubscribe();
  });
}

test("a running search can grow beyond its previously final loaded page", async () => {
  const current = job("growing");
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const f = fixture({
    async get(suffix, query) {
      if (suffix === "/jobs") return { jobs: [], nextCursor: null };
      if (suffix.endsWith("/entries")) {
        const offset =
          query.cursor === "after-b" ? 2 : query.cursor === "after-d" ? 4 : 0;
        return {
          entries: rows.slice(offset, offset + 2),
          nextCursor:
            rows.length > offset + 2 ? (offset === 0 ? "after-b" : "after-d") : null,
        };
      }
      return { ...current };
    },
    mutate: async () => ({ ...current }),
  });
  try {
    await f.session.start("scope", { kind: "search" });
    await f.session.refresh();
    await f.session.refresh({ jobId: "growing", cursor: "after-b" });
    assert.equal(f.session.getSnapshot().entries.growing.nextCursor, null);
    rows.push({ id: "d" }, { id: "e" });
    current.status = "completed";
    await f.session.refresh();
    assert.equal(f.session.getSnapshot().entries.growing.nextCursor, "after-d");
    await f.session.refresh({ jobId: "growing", cursor: "after-d" });
    assert.deepEqual(
      f.session.getSnapshot().entries.growing.entries.map((entry) => entry.id),
      ["a", "b", "c", "d", "e"],
    );
    assert.equal(f.session.getSnapshot().entries.growing.nextCursor, null);
  } finally {
    f.unsubscribe();
  }
});

test("bounded mutation sweeps refresh earlier stable rows and finish every terminal page", async () => {
  const current = job("move-many", { kind: "move" });
  const rows = Array.from({ length: 11 }, (_, index) => ({
    id: String(index),
    source: `source-${index}`,
    sourceRemoved: false,
  }));
  let reads = 0;
  const f = fixture({
    async get(suffix, query) {
      if (suffix === "/jobs") return { jobs: [], nextCursor: null };
      if (suffix.endsWith("/entries")) {
        reads++;
        const offset = query.cursor ? Number(query.cursor.replace("opaque-", "")) : 0;
        return {
          entries: rows.slice(offset, offset + 2).map((row) => ({ ...row })),
          nextCursor: offset + 2 < rows.length ? `opaque-${offset + 2}` : null,
        };
      }
      return { ...current };
    },
    mutate: async () => ({ ...current }),
  });
  try {
    await f.session.start("scope", { kind: "move" });
    await f.session.refresh();
    assert.equal(reads, 4);
    assert.equal(
      f.session.getSnapshot().entries["move-many"].entries[0].sourceRemoved,
      false,
    );
    rows[0].sourceRemoved = true;
    current.status = "partially_completed";
    reads = 0;
    await f.session.refresh();
    assert.equal(reads, 4);
    assert.equal(
      f.session.getSnapshot().entries["move-many"].entries[0].sourceRemoved,
      true,
    );
    assert.notEqual(f.session.getSnapshot().entries["move-many"].complete, true);
    await f.session.refresh();
    const result = f.session.getSnapshot().entries["move-many"];
    assert.equal(result.entries.length, 11);
    assert.equal(result.complete, true);
    assert.equal(result.entries.at(-1).sourceRemoved, false);
    rows[0].sourceRemoved = false;
    rows[0].sourceRemovalPending = true;
    await f.session.refresh();
    assert.equal(
      f.session.getSnapshot().entries["move-many"].entries[0].sourceRemovalPending,
      true,
    );
  } finally {
    f.unsubscribe();
  }
});
