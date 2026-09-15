import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { uploadFixture, uploadRequest } from "../helpers/file-uploads.js";
import { zipEntries } from "../helpers/file-archives.js";
import { resolveFile, entryRevision } from "../../server/features/files/file-paths.js";

async function fixture(t) {
  const f = await uploadFixture(t);
  const actual = path.join(f.home, "actual"),
    lexical = path.join(f.home, "lexical");
  await fs.mkdir(path.join(actual, "deep"), { recursive: true });
  await fs.mkdir(lexical);
  await fs.symlink(path.join(actual, "deep"), path.join(lexical, "link"));
  return { ...f, actual, lexical, selected: `${lexical}/link/..` };
}
async function run(f, extra, decision) {
  const op = {
    requestId: uploadRequest(),
    sources: [],
    target: f.selected,
    name: null,
    options: {},
    ...extra,
  };
  const job = await f.jobs.start(f.scope, op);
  if (decision) {
    const waiting = await f.until(() => {
      const value = f.jobs.get(f.scope, job.id);
      return (value.conflict || ["failed", "completed"].includes(value.status)) && value;
    });
    assert.ok(waiting.conflict, JSON.stringify(waiting));
    await f.jobs.resolve(f.scope, job.id, {
      conflictId: waiting.conflict.id,
      decision,
      applyToRemaining: false,
    });
  }
  const result = await f.jobs.join(f.scope, job.id);
  assert.equal(result.status, "completed", JSON.stringify(result));
  return result;
}

test("listing selected symlink/.. children reads actual bytes and absent lexical counterparts", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(`${f.lexical}/deep`);
  await fs.writeFile(`${f.actual}/same.txt`, "ACTUAL");
  await fs.writeFile(`${f.lexical}/same.txt`, "WRONG PATH DATA");
  const first = await f.listings.list(f.scope, { path: f.selected });
  const row = first.entries.find((entry) => entry.name === "same.txt");
  assert.equal(row.path, `${f.selected}/same.txt`);
  assert.equal(row.size, 6);
  await fs.writeFile(`${f.actual}/only.txt`, "ONLY ACTUAL");
  const second = await f.listings.list(f.scope, { path: f.selected });
  assert.equal(second.entries.find((entry) => entry.name === "only.txt").size, 11);
  assert.equal(await fs.readFile(row.path, "utf8"), "ACTUAL");
});

for (const kind of ["create_file", "create_directory"])
  for (const keepBoth of [false, true])
    test(`${kind} preserves selected symlink/.. target${keepBoth ? " with keep-both" : ""}`, async (t) => {
      const f = await fixture(t),
        name = "new.txt";
      if (keepBoth) {
        await fs.writeFile(`${f.actual}/${name}`, "occupied");
        await fs.writeFile(`${f.actual}/new (2).txt`, "also occupied");
      }
      await run(f, { kind, name }, keepBoth && "keep_both");
      const output = `${f.actual}/${keepBoth ? "new (3).txt" : name}`;
      assert.equal((await fs.lstat(output)).isDirectory(), kind === "create_directory");
      if (kind === "create_file") assert.equal(await fs.readFile(output, "utf8"), "");
      assert.deepEqual(await fs.readdir(f.lexical), ["link"]);
      if (keepBoth)
        assert.equal(await fs.readFile(`${f.actual}/${name}`, "utf8"), "occupied");
    });

test("rename and its keep-both destination preserve selected path and source inode", async (t) => {
  const f = await fixture(t),
    source = `${f.selected}/source.txt`;
  await fs.writeFile(`${f.actual}/source.txt`, "source");
  await fs.writeFile(`${f.actual}/renamed.txt`, "occupied");
  const selected = await resolveFile(f.scope, source, { followLeaf: false });
  await run(
    f,
    {
      kind: "rename",
      sources: [source],
      target: null,
      name: "renamed.txt",
      options: {
        revisions: { [source]: entryRevision(selected.stat, selected.linkIdentity) },
      },
    },
    "keep_both",
  );
  assert.equal(
    (await fs.lstat(`${f.actual}/renamed (2).txt`, { bigint: true })).ino,
    selected.stat.ino,
  );
  assert.equal(await fs.readFile(`${f.actual}/renamed.txt`, "utf8"), "occupied");
  assert.deepEqual(await fs.readdir(f.lexical), ["link"]);
});

for (const kind of ["copy", "move"])
  test(`${kind} keep-both outputs and result paths stay under selected symlink/..`, async (t) => {
    const f = await fixture(t),
      source = `${f.project}/source.txt`;
    await fs.writeFile(source, "source");
    await fs.writeFile(`${f.actual}/source.txt`, "occupied");
    await fs.writeFile(`${f.actual}/source (2).txt`, "also occupied");
    const result = await run(f, { kind, sources: [source] }, "keep_both");
    assert.equal(await fs.readFile(`${f.actual}/source (3).txt`, "utf8"), "source");
    assert.deepEqual(await fs.readdir(f.lexical), ["link"]);
    const rows = f.jobs.entries(f.scope, result.id).entries;
    assert.equal(rows[0].path, `${f.selected}/source (3).txt`);
    assert.equal(rows[0].sourceRemoved, kind === "move");
  });

test("copy merge preserves selected source and destination child identities", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(`${f.actual}/tree`);
  await fs.writeFile(`${f.actual}/tree/child.txt`, "ACTUAL CHILD");
  await fs.mkdir(`${f.project}/tree`);
  await fs.writeFile(`${f.project}/tree/existing.txt`, "retain");
  const result = await run(
    f,
    { kind: "copy", sources: [`${f.selected}/tree`], target: f.project },
    "merge",
  );
  assert.equal(await fs.readFile(`${f.project}/tree/child.txt`, "utf8"), "ACTUAL CHILD");
  assert.equal(await fs.readFile(`${f.project}/tree/existing.txt`, "utf8"), "retain");
  const rows = f.jobs.entries(f.scope, result.id).entries;
  assert.ok(rows.some((row) => row.source === `${f.selected}/tree/child.txt`));
  await fs.mkdir(`${f.actual}/other`);
  await fs.mkdir(`${f.project}/other`);
  await fs.writeFile(`${f.project}/other/new.txt`, "new");
  await run(f, { kind: "copy", sources: [`${f.project}/other`] }, "merge");
  assert.equal(await fs.readFile(`${f.actual}/other/new.txt`, "utf8"), "new");
  assert.deepEqual(await fs.readdir(f.lexical), ["link"]);
});

test("public ZIP keep-both writes archive only under the selected symlink/.. target", async (t) => {
  const f = await fixture(t),
    source = `${f.project}/source.txt`;
  await fs.writeFile(source, "ZIP SOURCE");
  await fs.writeFile(`${f.actual}/out.zip`, "occupied");
  await run(
    f,
    { kind: "archive", sources: [source], name: "out.zip", options: { output: "file" } },
    "keep_both",
  );
  const entries = await zipEntries(await fs.readFile(`${f.actual}/out (2).zip`));
  assert.equal(entries.get("source.txt").toString(), "ZIP SOURCE");
  assert.equal(await fs.readFile(`${f.actual}/out.zip`, "utf8"), "occupied");
  assert.deepEqual(await fs.readdir(f.lexical), ["link"]);
});

for (const kind of ["create_file", "create_directory", "rename", "archive"])
  test(`${kind} retry proposal preserves the selected symlink/.. destination`, async (t) => {
    const f = await fixture(t),
      source = `${f.selected}/source.txt`;
    await fs.writeFile(`${f.actual}/source.txt`, "source");
    const resolved = await resolveFile(f.scope, source, { followLeaf: false });
    const op = {
      requestId: uploadRequest(),
      kind,
      target: kind === "rename" ? null : f.selected,
      name: kind === "archive" ? "out.zip" : "new.txt",
      sources: ["rename", "archive"].includes(kind) ? [source] : [],
      options:
        kind === "archive"
          ? { output: "file" }
          : kind === "rename"
            ? {
                revisions: {
                  [source]: entryRevision(resolved.stat, resolved.linkIdentity),
                },
              }
            : {},
    };
    const { job } = f.store.request(f.scope, op);
    f.store.transition(job.id, "queued", "failed");
    const proposal = await f.retries.preview(f.scope, job.id);
    assert.equal(proposal.entries[0].path, `${f.selected}/${op.name}`);
  });

test("creation retains selected-link revalidation when its canonical parent changes", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(`${f.lexical}/other-deep`);
  const stage = f.publisher.stage.bind(f.publisher);
  f.publisher.stage = async (...args) => {
    const value = await stage(...args);
    await fs.unlink(`${f.lexical}/link`);
    await fs.symlink(`${f.lexical}/other-deep`, `${f.lexical}/link`);
    return value;
  };
  const job = await f.jobs.start(f.scope, {
    requestId: uploadRequest(),
    kind: "create_file",
    sources: [],
    target: f.selected,
    name: "new.txt",
    options: {},
  });
  const result = await f.jobs.join(f.scope, job.id);
  assert.equal(result.status, "failed");
  assert.equal(result.issue.code, "FILE_CONFLICT_CHANGED");
  await assert.rejects(fs.lstat(`${f.actual}/new.txt`), { code: "ENOENT" });
  await assert.rejects(fs.lstat(`${f.lexical}/new.txt`), { code: "ENOENT" });
});
