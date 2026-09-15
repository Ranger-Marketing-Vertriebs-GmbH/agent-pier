import test from "node:test";
import assert from "node:assert/strict";
import { FileJobClient } from "../../web/features/files/file-job-client.js";

const job = (id, extra = {}) => ({
  id,
  scopeId: "scope",
  kind: "copy",
  status: "completed",
  completedEntries: 1,
  totalEntries: 1,
  completedBytes: 1,
  totalBytes: 1,
  conflict: null,
  issue: null,
  ...extra,
});
const row = (id, extra = {}) => ({
  id,
  source: `/source/${id}`,
  path: `/target/${id}`,
  status: "completed",
  outputPublished: true,
  sourceRemoved: false,
  ...extra,
});
function fixture(t) {
  const remote = new Map(),
    results = new Map(),
    calls = [];
  let history = [];
  const client = {
    async get(suffix, query = {}) {
      calls.push(suffix);
      if (suffix === "/jobs") return { jobs: structuredClone(history), nextCursor: null };
      const id = suffix.split("/")[2];
      if (!remote.has(id))
        throw Object.assign(Error("expired"), { code: "FILE_NOT_FOUND", status: 404 });
      if (!suffix.endsWith("/entries")) return structuredClone(remote.get(id));
      const rows = results.get(id),
        offset = Number(query.cursor || 0);
      if (rows instanceof Error) throw rows;
      return {
        entries: structuredClone(rows.slice(offset, offset + 200)),
        nextCursor: rows.length > offset + 200 ? String(offset + 200) : null,
      };
    },
    async mutate(_, { body }) {
      return structuredClone(remote.get(body.requestId));
    },
  };
  const session = new FileJobClient(client, {
    hidden: () => false,
    listen: () => () => {},
    timer: () => 1,
    clear: () => {},
  });
  t.after(session.subscribe(() => {}));
  return {
    session,
    remote,
    results,
    calls,
    history: (value) => {
      history = value;
    },
    add(id, extra = {}, rows = [row(id)]) {
      const value = job(id, extra);
      remote.set(id, value);
      results.set(id, rows);
      return value;
    },
  };
}

test("more than 200 settled general jobs retire after final sweeps and stop routine reads", async (t) => {
  const f = fixture(t);
  await f.session.tail;
  for (let i = 0; i < 205; i++) {
    f.add(String(i));
    await f.session.start("scope", { requestId: String(i), kind: "copy" });
  }
  for (let i = 0; i < 52; i++) await f.session.refresh();
  assert.equal(f.session.tracked.size, 0);
  for (let i = 0; i < 205; i++) assert.equal(f.session.state.entries[i].complete, true);
  f.calls.length = 0;
  await f.session.refresh();
  assert.deepEqual(f.calls, ["/jobs"]);
  assert.ok(f.session.state.jobs.length <= 200);
  assert.equal(f.session.state.history.jobs.length, 0);
});

for (const phase of ["detail", "results"])
  test(`an expired ${phase} ID cannot stall later progress or discard retained results`, async (t) => {
    const f = fixture(t);
    await f.session.tail;
    f.add("old", { status: "running" }, [row("old", { status: "pending" })]);
    f.add("current", { status: "running" }, [row("current", { status: "pending" })]);
    for (const id of ["old", "current"])
      await f.session.start("scope", { requestId: id, kind: "copy" });
    await f.session.refresh();
    if (phase === "detail") f.remote.delete("old");
    else
      f.results.set(
        "old",
        Object.assign(Error("expired"), { code: "FILE_NOT_FOUND", status: 404 }),
      );
    f.remote.set("current", job("current"));
    f.results.set("current", [row("current")]);
    await f.session.refresh();
    assert.equal(f.session.state.entries.current.entries[0].status, "completed");
    assert.equal(f.session.state.entries.current.complete, true);
    assert.equal(f.session.state.entries.old.entries[0].status, "pending");
    assert.equal(f.session.tracked.has("old"), false);
    f.calls.length = 0;
    await f.session.refresh();
    assert.ok(!f.calls.some((suffix) => suffix.startsWith("/jobs/old")));
  });

test("active, conflict, unresolved publication and pending source removal remain watched", async (t) => {
  const f = fixture(t);
  await f.session.tail;
  const cases = [
    ["active", { status: "running" }, row("active")],
    [
      "conflict",
      { status: "waiting_for_conflict", conflict: { id: "choice" } },
      row("conflict"),
    ],
    [
      "pending",
      { kind: "move", status: "partially_completed" },
      row("pending", { status: "published", sourceRemovalPending: true }),
    ],
    [
      "unknown",
      { status: "interrupted" },
      row("unknown", { status: "pending", outputPublished: false }),
    ],
  ];
  for (const [id, extra, entry] of cases) {
    f.add(id, extra, [entry]);
    await f.session.start("scope", { requestId: id, kind: extra.kind || "copy" });
  }
  await f.session.refresh();
  await f.session.refresh();
  assert.deepEqual(
    [...f.session.tracked.keys()],
    cases.map(([id]) => id),
  );
  f.remote.set("pending", job("pending", { kind: "move" }));
  f.results.set("pending", [
    row("pending", { sourceRemovalPending: false, sourceRemoved: true }),
  ]);
  await f.session.refresh();
  assert.equal(f.session.tracked.has("pending"), false);
  // Cut consumers retain the exact positive removal proof after retirement.
  assert.equal(f.session.state.entries.pending.entries[0].sourceRemoved, true);
});

test("selected inspection continues polling while a later selection releases the prior settled watch", async (t) => {
  const f = fixture(t);
  await f.session.tail;
  f.add("selected");
  f.add("next");
  await f.session.operations.inspect("scope", "selected");
  await f.session.refresh();
  assert.equal(f.session.tracked.has("selected"), true);
  f.results.set("selected", [row("selected", { sourceRemoved: true })]);
  await f.session.refresh();
  assert.equal(f.session.state.entries.selected.entries[0].sourceRemoved, true);
  await f.session.operations.inspect("scope", "next");
  await f.session.refresh();
  assert.equal(f.session.tracked.has("selected"), false);
  assert.equal(f.session.tracked.has("next"), true);
  assert.equal(f.session.state.entries.selected.entries[0].sourceRemoved, true);
});

test("purge final-page proof and last job metadata survive routine retirement", async (t) => {
  const f = fixture(t);
  await f.session.tail;
  const rows = Array.from({ length: 1001 }, (_, i) =>
    row(String(i), { sourceRemoved: true }),
  );
  f.add(
    "purge",
    { kind: "purge", totalEntries: rows.length, completedEntries: rows.length },
    rows,
  );
  await f.session.start("scope", { requestId: "purge", kind: "purge" });
  await f.session.refresh();
  assert.notEqual(f.session.state.entries.purge.complete, true);
  assert.equal(f.session.tracked.has("purge"), true);
  await f.session.refresh();
  assert.equal(f.session.tracked.has("purge"), false);
  await f.session.refresh();
  assert.equal(
    f.session.state.jobs.find((value) => value.id === "purge").status,
    "completed",
  );
  assert.equal(f.session.state.entries.purge.complete, true);
  assert.equal(
    f.session.state.entries.purge.entries.filter((entry) => entry.sourceRemoved).length,
    1001,
  );
});

test("interrupted empty outcomes and recovery issues cannot be retired as settled failures", async (t) => {
  const f = fixture(t);
  await f.session.tail;
  for (const [id, extra, rows] of [
    ["interrupted", { status: "interrupted" }, []],
    [
      "recovery",
      { status: "failed", issue: { code: "FILE_RENAME_RECOVERY", args: {} } },
      [row("recovery")],
    ],
    [
      "partial",
      { status: "partially_completed", issue: { code: "FILE_INTERRUPTED", args: {} } },
      [row("partial")],
    ],
  ]) {
    f.add(id, extra, rows);
    await f.session.start("scope", { requestId: id, kind: "copy" });
  }
  await f.session.refresh();
  assert.deepEqual([...f.session.tracked.keys()], ["interrupted", "recovery", "partial"]);
});

test("scoped expiration handling does not swallow authorization or transport failures", async (t) => {
  const f = fixture(t);
  await f.session.tail;
  f.add(
    "denied",
    {},
    Object.assign(Error("denied"), { code: "FILE_ACCESS_DENIED", status: 403 }),
  );
  await f.session.start("scope", { requestId: "denied", kind: "copy" });
  await assert.rejects(f.session.refresh(), { code: "FILE_ACCESS_DENIED" });
  assert.equal(f.session.tracked.has("denied"), true);
});

test("observed purge metadata survives a different full history page arriving before retirement", async (t) => {
  const f = fixture(t);
  await f.session.tail;
  f.add("purge", { kind: "purge", status: "running" }, [
    row("purge", { status: "pending", sourceRemoved: false }),
  ]);
  await f.session.start("scope", { requestId: "purge", kind: "purge" });
  await f.session.refresh();
  const history = Array.from({ length: 200 }, (_, i) => f.add(`history-${i}`));
  f.history(history);
  await f.session.uploads.history("scope", null);
  f.remote.set("purge", job("purge", { kind: "purge" }));
  f.results.set("purge", [row("purge", { sourceRemoved: true })]);
  await f.session.refresh();
  await f.session.refresh();
  assert.equal(f.session.tracked.has("purge"), false);
  assert.equal(
    f.session.state.jobs.find((value) => value.id === "purge")?.status,
    "completed",
  );
  assert.equal(f.session.state.entries.purge.complete, true);
  assert.equal(f.session.state.history.jobs.length, 200);
  assert.ok(f.session.state.jobs.length <= 200);
});

test("new completed Cut work remains visible on the refreshed first history page after retirement", async (t) => {
  const f = fixture(t);
  await f.session.tail;
  assert.deepEqual(f.session.state.history.jobs, []);
  const current = f.add("cut", { kind: "move" }, [row("cut", { sourceRemoved: true })]);
  await f.session.start("scope", { requestId: "cut", kind: "move" });
  f.history([current]);
  await f.session.refresh();
  assert.equal(f.session.tracked.has("cut"), false);
  assert.deepEqual(
    f.session.state.history.jobs.map((value) => value.id),
    ["cut"],
  );
  assert.equal(f.session.state.history.jobs[0].status, "completed");
  assert.equal(f.session.state.entries.cut.entries[0].sourceRemoved, true);
});

test("a long-running purge keeps its newly completed metadata after more than 200 other jobs finish", async (t) => {
  const f = fixture(t);
  await f.session.tail;
  f.add("purge", { kind: "purge", status: "running" }, [
    row("purge", { status: "pending", sourceRemoved: false }),
  ]);
  await f.session.start("scope", { requestId: "purge", kind: "purge" });
  for (let i = 0; i < 205; i++) {
    f.add(String(i));
    await f.session.start("scope", { requestId: String(i), kind: "copy" });
    await f.session.refresh();
  }
  f.remote.set("purge", job("purge", { kind: "purge" }));
  f.results.set("purge", [row("purge", { sourceRemoved: true })]);
  await f.session.refresh();
  assert.equal(
    f.session.state.jobs.find((value) => value.id === "purge")?.status,
    "completed",
  );
  assert.equal(f.session.state.entries.purge.complete, true);
  assert.equal(f.session.tracked.has("purge"), false);
  assert.ok(f.session.state.jobs.length <= 200);
});
