import test from "node:test";
import assert from "node:assert/strict";
import { FileJobClient } from "../../web/features/files/file-job-client.js";

const job = (id, extra = {}) => ({
  id,
  kind: "extract",
  status: "completed",
  scopeId: "scope",
  conflict: null,
  ...extra,
});
function fixture(t) {
  const first = Array.from({ length: 200 }, (_, i) => job(`old-${i}`));
  first[0] = job("directory", { kind: "create_directory", status: "running" });
  first[1] = job("metadata", { kind: "size", status: "running" });
  const remote = new Map(first.map((value) => [value.id, value])),
    calls = [];
  remote.set("later", job("later", { status: "running" }));
  remote.set(
    "owned-directory",
    job("owned-directory", { kind: "create_directory", uploadGroupId: "old-group" }),
  );
  const session = new FileJobClient(
    {
      async get(suffix, query = {}) {
        calls.push({ suffix, ...query });
        return structuredClone(
          suffix === "/jobs"
            ? query.cursor
              ? { jobs: [remote.get("later")], nextCursor: null }
              : {
                  jobs: first.map((value) => remote.get(value.id)),
                  nextCursor: "page-200",
                }
            : suffix.endsWith("/entries")
              ? { entries: [], nextCursor: null }
              : remote.get(suffix.split("/").at(-1)),
        );
      },
    },
    { hidden: () => false, listen: () => () => {}, timer: () => 1, clear: () => {} },
  );
  t.after(session.subscribe(() => {}));
  return { session, remote, calls };
}
test("explicit later history adopts active work through conflicts and final states without entry inspection", async (t) => {
  const { session, remote, calls } = fixture(t);
  await session.tail;
  await session.uploads.history("scope", "page-200");
  remote.set(
    "later",
    job("later", { status: "waiting_for_conflict", conflict: { id: "fresh" } }),
  );
  await session.refresh();
  assert.equal(
    session.state.jobs.find((value) => value.id === "later")?.conflict?.id,
    "fresh",
  );
  assert.equal(session.state.history.jobs[0].status, "waiting_for_conflict");
  await session.uploads.history("scope", null);
  remote.set("later", job("later"));
  remote.set("directory", job("directory", { kind: "create_directory" }));
  remote.set("metadata", job("metadata", { kind: "size" }));
  await session.refresh();
  assert.equal(
    session.state.jobs.find((value) => value.id === "later").status,
    "completed",
  );
  assert.equal(
    session.state.history.jobs.find((value) => value.id === "directory").status,
    "completed",
  );
  assert.equal(
    session.state.history.jobs.find((value) => value.id === "metadata").status,
    "completed",
  );
  assert.ok(calls.some((value) => value.suffix === "/jobs/later"));
  assert.ok(calls.filter((value) => value.suffix.endsWith("/entries")).length <= 8);
});
test("generic terminal upload-directory inspection does not install a watch beyond its selected owner", async (t) => {
  const { session, calls } = fixture(t);
  await session.tail;
  session.uploads.transient.set("owned-directory", "old-group");
  session.accept(
    job("owned-directory", {
      kind: "create_directory",
      status: "running",
      uploadGroupId: "old-group",
    }),
    true,
  );
  await session.operations.inspect("scope", "owned-directory");
  assert.equal(session.uploads.transient.has("owned-directory"), false);
  session.uploads.select("another-group");
  calls.length = 0;
  await session.refresh();
  await session.refresh();
  assert.equal(session.tracked.has("owned-directory"), false);
  assert.equal(
    calls.filter((value) => value.suffix === "/jobs/owned-directory").length,
    0,
  );
  assert.equal(
    calls.filter((value) => value.suffix === "/jobs/owned-directory/entries").length,
    0,
  );
});
