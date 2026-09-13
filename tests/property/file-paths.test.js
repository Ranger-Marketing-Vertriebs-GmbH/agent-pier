import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import fc from "fast-check";
import { fileFixture } from "../helpers/file-explorer.js";
import {
  resolveFile,
  isWithin,
  entryRevision,
} from "../../server/features/files/file-paths.js";

test("global navigation follows an OS-accessible link while project scope rejects it", async (t) => {
  const f = await fileFixture(t);
  await fs.symlink(f.home, path.join(f.project, "outside"));
  await assert.rejects(resolveFile(f.projectScope, "outside"), {
    code: "FILE_OUTSIDE_SCOPE",
  });
  const found = await resolveFile(f.globalScope, path.join(f.project, "outside"));
  assert.equal(found.absolute, f.home);
  assert.equal(found.path, path.join(f.project, "outside"));
  const selected = await resolveFile(f.projectScope, "outside", { followLeaf: false });
  assert.ok(selected.stat.isSymbolicLink());
  assert.equal(selected.absolute, path.join(f.project, "outside"));
});

test("project rejects absolute inputs, NUL, traversal and escaping parent links", async (t) => {
  const f = await fileFixture(t);
  await fs.symlink(f.home, path.join(f.project, "escape"));
  for (const input of [f.project, "../project", "../project-other", "escape/new"])
    await assert.rejects(resolveFile(f.projectScope, input, { allowMissingLeaf: true }), {
      code: "FILE_OUTSIDE_SCOPE",
    });
  for (const input of ["file\0", null, 42])
    await assert.rejects(resolveFile(f.projectScope, input), {
      code: "FILE_INVALID_PATH",
    });
  await assert.rejects(resolveFile(f.globalScope, "relative"), {
    code: "FILE_INVALID_PATH",
  });
});

test("missing leaf is allowed only beneath an existing directory", async (t) => {
  const f = await fileFixture(t);
  await fs.writeFile(path.join(f.project, "file"), "x");
  const missing = await resolveFile(f.projectScope, "new", { allowMissingLeaf: true });
  assert.equal(missing.stat, null);
  assert.equal(missing.parent, f.project);
  assert.equal(missing.name, "new");
  await assert.rejects(resolveFile(f.projectScope, "new"), { code: "FILE_NOT_FOUND" });
  await assert.rejects(
    resolveFile(f.projectScope, "missing/new", { allowMissingLeaf: true }),
    { code: "FILE_NOT_FOUND" },
  );
  await assert.rejects(
    resolveFile(f.projectScope, "file/new", { allowMissingLeaf: true }),
    { code: "FILE_NOT_DIRECTORY" },
  );
});

test("dangling and looping links remain selectable but cannot be followed or treated as missing", async (t) => {
  const f = await fileFixture(t);
  await fs.symlink("missing", path.join(f.project, "dangling"));
  await fs.symlink("loop", path.join(f.project, "loop"));
  for (const [name, code] of [
    ["dangling", "FILE_NOT_FOUND"],
    ["loop", "FILE_LINK_LOOP"],
  ]) {
    const selected = await resolveFile(f.projectScope, name, { followLeaf: false });
    assert.ok(selected.stat.isSymbolicLink());
    await assert.rejects(resolveFile(f.projectScope, name, { allowMissingLeaf: true }), {
      code,
    });
  }
});

test("following a link preserves its selected path and detects replacement even at the same target", async (t) => {
  const f = await fileFixture(t);
  await fs.writeFile(path.join(f.project, "target"), "same");
  const alias = path.join(f.project, "alias");
  await fs.symlink("target", alias);
  const first = await resolveFile(f.projectScope, "alias");
  assert.equal(first.path, "alias");
  assert.equal(first.absolute, path.join(f.project, "target"));
  assert.equal(typeof first.linkIdentity, "string");
  await fs.rename(alias, `${alias}-old`);
  await fs.symlink("target", alias);
  const second = await resolveFile(f.projectScope, "alias");
  assert.notEqual(
    entryRevision(first.stat, first.linkIdentity),
    entryRevision(second.stat, second.linkIdentity),
  );
});

test("global dot-dot after a directory link follows OS directory semantics", async (t) => {
  const f = await fileFixture(t);
  await fs.mkdir(path.join(f.home, "nested"));
  await fs.symlink(path.join(f.home, "nested"), path.join(f.project, "alias"));
  const found = await resolveFile(f.globalScope, `${f.project}/alias/..`);
  assert.equal(found.absolute, f.home);
});

test("terminal dot segments retain the operating system's directory requirement", async (t) => {
  const f = await fileFixture(t);
  await fs.writeFile(path.join(f.project, "regular"), "x");
  await fs.mkdir(path.join(f.project, "directory"));
  await assert.rejects(resolveFile(f.projectScope, "regular/."), {
    code: "FILE_NOT_DIRECTORY",
  });
  assert.equal(
    (await resolveFile(f.projectScope, "directory/.")).absolute,
    path.join(f.project, "directory"),
  );
});

test("containment rejects adjacent prefixes and any generated parent escape", async (t) => {
  const f = await fileFixture(t);
  const segment = fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/);
  await fc.assert(
    fc.asyncProperty(segment, async (name) => {
      assert.equal(isWithin(f.project, `${f.project}-${name}`), false);
      assert.equal(isWithin(f.project, path.join(f.project, name)), true);
      await assert.rejects(
        resolveFile(f.projectScope, `../project-${name}`, { allowMissingLeaf: true }),
        { code: "FILE_OUTSIDE_SCOPE" },
      );
    }),
    { numRuns: 100 },
  );
});

test("a project root replaced by an escaping symlink cannot authorize reads", async (t) => {
  const f = await fileFixture(t);
  await fs.writeFile(path.join(f.home, "secret"), "private");
  await fs.rename(f.project, `${f.project}-old`);
  await fs.symlink(f.home, f.project);
  await assert.rejects(resolveFile(f.projectScope, "secret"), {
    code: "FILE_OUTSIDE_SCOPE",
  });
  await assert.rejects(resolveFile(f.projectScope, ""), { code: "FILE_OUTSIDE_SCOPE" });
});

test("link targets containing link-dot-dot use the OS target instead of lexical collapse", async (t) => {
  const f = await fileFixture(t);
  await fs.mkdir(path.join(f.home, "nested"));
  await fs.symlink(path.join(f.home, "nested"), path.join(f.project, "other"));
  await fs.symlink("other/..", path.join(f.project, "alias"));
  assert.equal(
    (await resolveFile(f.globalScope, path.join(f.project, "alias"))).absolute,
    f.home,
  );
  await assert.rejects(resolveFile(f.projectScope, "alias"), {
    code: "FILE_OUTSIDE_SCOPE",
  });
});
