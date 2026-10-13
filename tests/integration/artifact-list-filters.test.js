import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { artifactFixture } from "../helpers/artifacts.js";

async function publish(f, title, context = f.context) {
  return f.service.publish(
    context,
    { requestId: randomUUID(), title, sourcePath: "report.html" },
    async () => {},
  );
}

test("artifact lists filter by title search and pin state and count both tabs", async (t) => {
  const f = await artifactFixture(t);
  await fs.writeFile(path.join(f.workspace, "report.html"), "<h1>report</h1>");
  const audit = await publish(f, "Lighthouse Audit");
  const notes = await publish(f, "Release notes");
  const other = await publish(f, "Audit summary", {
    ...f.context,
    sessionId: "session-two",
    projectId: "project-two",
  });
  await f.service.setPinned(notes.id, true);
  await f.service.setPinned(other.id, true);

  const all = await f.service.list();
  assert.equal(all.total, 3);
  assert.deepEqual(all.counts, { all: 3, pinned: 2 });
  assert.equal(all.items[0].fileCount, 1);

  const pinned = await f.service.list({ pinned: true });
  assert.deepEqual(
    pinned.items.map((item) => item.id),
    [other.id, notes.id],
  );
  assert.equal(pinned.total, 2);
  assert.deepEqual(pinned.counts, { all: 3, pinned: 2 });

  // Case-insensitive title match; counts follow the search but not the pin filter.
  const search = await f.service.list({ q: "  aUdIt " });
  assert.deepEqual(
    search.items.map((item) => item.id).sort(),
    [audit.id, other.id].sort(),
  );
  assert.deepEqual(search.counts, { all: 2, pinned: 1 });
  const scoped = await f.service.list({ q: "audit", projectId: "project-one" });
  assert.deepEqual(
    scoped.items.map((item) => item.id),
    [audit.id],
  );
  assert.deepEqual(
    (await f.service.list({ q: "audit", pinned: true })).items.map((item) => item.id),
    [other.id],
  );

  // Session and project names are resolved by the caller and passed as matches.
  const named = await f.service.list({ q: "nightly", matches: ["session-two"] });
  assert.deepEqual(
    named.items.map((item) => item.id),
    [other.id],
  );
  assert.equal((await f.service.list({ q: "nothing" })).total, 0);
  assert.equal((await f.service.list({ q: "" })).total, 3);

  for (const invalid of [
    { q: "x".repeat(201) },
    { q: "line\nbreak" },
    { q: 3 },
    { pinned: "true" },
  ])
    await assert.rejects(f.service.list(invalid), { code: "ARTIFACT_INVALID_INPUT" });
});
