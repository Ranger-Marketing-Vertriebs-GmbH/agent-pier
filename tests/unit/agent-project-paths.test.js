import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectTarget } from "../../server/features/assistants/project-paths.js";
import {
  editFile,
  listFolder,
  readFile,
  searchFolder,
  writeFile,
} from "../../server/features/assistants/project-files.js";

// A host with two sibling projects, AgentPier's data dir inside the first one and a
// secret outside both.
function host(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-paths-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, "app");
  const sibling = path.join(base, "app-other");
  const data = path.join(project, "agentpier-data");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  fs.mkdirSync(path.join(project, ".agentpier-worktrees", "run"), { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(project, "src", "index.js"), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(project, ".git", "config"), "[remote] url=token@host");
  fs.writeFileSync(path.join(data, "secret.json"), "{}");
  fs.writeFileSync(path.join(sibling, "notes.md"), "sibling");
  fs.writeFileSync(path.join(base, "secret.txt"), "outside");
  return { base, project, sibling, data, options: { protectedRoots: [data] } };
}
const refused = { status: 403, key: "projectPathRefused" };

test("a granted root resolves relative and absolute paths inside it", (t) => {
  const h = host(t);
  for (const raw of [
    "src/index.js",
    "./src//index.js",
    path.join(h.project, "src/index.js"),
  ])
    assert.equal(projectTarget(h.project, raw, h.options).relative, "src/index.js");
  assert.equal(projectTarget(h.project, undefined, h.options).relative, "");
  const created = projectTarget(h.project, "new/deep/file.txt", {
    ...h.options,
    write: true,
  });
  assert.equal(created.exists, false);
  assert.equal(created.relative, "new/deep/file.txt");
});

test("traversal, sibling projects and foreign absolute paths are refused", (t) => {
  const h = host(t);
  for (const raw of [
    "../secret.txt",
    "src/../../secret.txt",
    "src/../index.js",
    path.join(h.base, "secret.txt"),
    path.join(h.sibling, "notes.md"),
    `${h.project}-other/notes.md`,
    "~/secret.txt",
    "file:///etc/passwd",
    "@secret.txt",
    "src\\index.js",
    "src/\u0000index.js",
    "src/index.js\n",
  ])
    assert.throws(() => projectTarget(h.project, raw, h.options), refused, raw);
});

test(".git internals are refused for reading and writing in every spelling", (t) => {
  const h = host(t);
  for (const raw of [".git/config", ".GIT/config", ".Git", "sub/.git/HEAD", ".git"])
    for (const write of [false, true])
      assert.throws(
        () => projectTarget(h.project, raw, { ...h.options, write }),
        refused,
        `${raw} write=${write}`,
      );
  // Pipeline run checkouts may be read but never changed.
  assert.equal(
    projectTarget(h.project, ".agentpier-worktrees/run", h.options).relative,
    ".agentpier-worktrees/run",
  );
  assert.throws(
    () =>
      projectTarget(h.project, ".AgentPier-Worktrees/run/x", {
        ...h.options,
        write: true,
      }),
    refused,
  );
});

test("links may stay inside the folder but never lead out, into .git or the data dir", (t) => {
  const h = host(t);
  fs.symlinkSync(h.base, path.join(h.project, "escape"));
  fs.symlinkSync(path.join(h.base, "secret.txt"), path.join(h.project, "secret-link"));
  fs.symlinkSync(path.join(h.project, ".git"), path.join(h.project, "gitlink"));
  fs.symlinkSync(h.data, path.join(h.project, "datalink"));
  fs.symlinkSync(path.join(h.project, "src"), path.join(h.project, "srclink"));
  for (const raw of [
    "escape/secret.txt",
    "secret-link",
    "gitlink/config",
    "datalink/secret.json",
  ])
    for (const write of [false, true])
      assert.throws(
        () => projectTarget(h.project, raw, { ...h.options, write }),
        refused,
        `${raw} write=${write}`,
      );
  assert.throws(
    () => projectTarget(h.project, "agentpier-data/secret.json", h.options),
    refused,
  );
  assert.throws(
    () => projectTarget(h.project, "escape/new.txt", { ...h.options, write: true }),
    refused,
  );
  assert.equal(
    projectTarget(h.project, "srclink/index.js", h.options).relative,
    "src/index.js",
  );
});

test("file operations read, list, search, write and edit inside the root only", (t) => {
  const h = host(t);
  const listed = listFolder(h.project, undefined, h.options);
  assert.ok(listed.entries.some((e) => e.name === "src" && e.kind === "directory"));
  const read = readFile(h.project, "src/index.js", { ...h.options, offset: 2, limit: 1 });
  assert.equal(read.content, "two");
  assert.equal(read.truncated, true);
  const found = searchFolder(h.project, undefined, "url=", h.options);
  // .git and AgentPier's data are never searched.
  assert.deepEqual(found.matches, []);
  assert.equal(searchFolder(h.project, "src", "three", h.options).matches[0].line, 3);
  const written = writeFile(h.project, "docs/plan.md", "# Plan\n", h.options);
  assert.deepEqual(written, { path: "docs/plan.md", bytes: 7, created: true });
  assert.equal(fs.readFileSync(path.join(h.project, "docs/plan.md"), "utf8"), "# Plan\n");
  const edited = editFile(
    h.project,
    "docs/plan.md",
    { oldText: "Plan", newText: "Goal" },
    h.options,
  );
  assert.equal(edited.replacements, 1);
  assert.equal(fs.readFileSync(path.join(h.project, "docs/plan.md"), "utf8"), "# Goal\n");
  assert.throws(
    () =>
      editFile(
        h.project,
        "src/index.js",
        { oldText: "missing", newText: "x" },
        h.options,
      ),
    { status: 409, key: "projectEditNoMatch" },
  );
  assert.deepEqual(
    fs.readdirSync(path.join(h.project, "docs")),
    ["plan.md"],
    "no temporary file is left behind",
  );
});

test("writes replace a final link instead of following it and refuse hard links", (t) => {
  const h = host(t);
  const dangling = path.join(h.project, "dangling");
  fs.symlinkSync(path.join(h.base, "created-outside.txt"), dangling);
  writeFile(h.project, "dangling", "inside", h.options);
  assert.equal(fs.existsSync(path.join(h.base, "created-outside.txt")), false);
  assert.equal(fs.lstatSync(dangling).isFile(), true);
  fs.linkSync(path.join(h.base, "secret.txt"), path.join(h.project, "hard.txt"));
  assert.throws(() => writeFile(h.project, "hard.txt", "x", h.options), {
    key: "projectFileUnsuitable",
  });
  assert.equal(fs.readFileSync(path.join(h.base, "secret.txt"), "utf8"), "outside");
  fs.writeFileSync(path.join(h.project, "bin.dat"), Buffer.from([1, 0, 2]));
  assert.throws(() => readFile(h.project, "bin.dat", h.options), {
    key: "projectFileUnsuitable",
  });
});
