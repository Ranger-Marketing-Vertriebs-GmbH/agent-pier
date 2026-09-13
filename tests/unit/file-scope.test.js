import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileFixture } from "../helpers/file-explorer.js";
import { makeFileScope } from "../../server/features/files/file-scope.js";
import {
  entryRevision,
  resolveFile,
  assertFileMutationTarget,
  revalidateFileParent,
  validateFileName,
} from "../../server/features/files/file-paths.js";
import { readFileLimits } from "../../server/features/files/file-limits.js";
import { fileProblem } from "../../server/features/files/file-errors.js";
import { loadConfig } from "../../server/lib/config.js";
import { filesCopy } from "../../web/lib/i18n/messages/files.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

test("scope uses canonical trusted home and session cwd, binding identity to session and root", async (t) => {
  const f = await fileFixture(t);
  const alias = path.join(f.root, "alias");
  await fs.symlink(f.project, alias);
  const project = await makeFileScope({
    home: f.home,
    session: { id: "fixture", cwd: alias },
    root: "/",
    readOnly: true,
  });
  assert.deepEqual(project, f.projectScope);
  assert.equal(project.kind, "project");
  assert.equal(project.root, f.project);
  assert.equal(project.sessionId, "fixture");
  assert.equal(project.readOnly, false);
  assert.equal(f.globalScope.root, "/");
  assert.equal(f.globalScope.home, f.home);
  assert.equal(f.globalScope.sessionId, null);
  assert.notEqual(
    project.id,
    (await makeFileScope({ home: f.home, session: { id: "other", cwd: f.project } })).id,
  );
  assert.notEqual(
    project.id,
    (await makeFileScope({ home: f.home, session: { id: "fixture", cwd: f.home } })).id,
  );
});

test("headless readOnly derives only from the server session pipeline representation", async (t) => {
  const f = await fileFixture(t);
  const scope = await makeFileScope({
    home: f.home,
    session: {
      id: "fixture",
      cwd: f.project,
      pipeline: { headless: true },
      readOnly: false,
    },
    readOnly: false,
  });
  assert.equal(scope.readOnly, true);
  const file = path.join(f.project, "file");
  await fs.writeFile(file, "text");
  assert.throws(() => assertFileMutationTarget(scope, { absolute: file }), {
    code: "FILE_READ_ONLY",
  });
  assert.equal(
    (
      await makeFileScope({
        home: f.home,
        session: { id: "fixture", cwd: f.project, headless: true, readOnly: true },
      })
    ).readOnly,
    false,
  );
});

test("scopes reject invalid trusted directories and normalize a session tilde", async (t) => {
  const f = await fileFixture(t);
  const scope = await makeFileScope({
    home: f.home,
    session: { id: "fixture", cwd: "~/project" },
  });
  assert.equal(scope.root, f.project);
  await fs.writeFile(path.join(f.root, "file"), "x");
  await assert.rejects(makeFileScope({ home: path.join(f.root, "file") }), {
    code: "FILE_NOT_DIRECTORY",
  });
  await assert.rejects(
    makeFileScope({ home: f.home, session: { id: "", cwd: f.project } }),
    { code: "FILE_INVALID_SCOPE" },
  );
  await assert.rejects(
    makeFileScope({ home: f.home, session: { id: "x", cwd: "relative" } }),
    { code: "FILE_INVALID_SCOPE" },
  );
});

test("root contexts are readable and protected from mutations", async (t) => {
  const f = await fileFixture(t);
  for (const [scope, input] of [
    [f.projectScope, ""],
    [f.globalScope, "/"],
  ]) {
    const result = await resolveFile(scope, input);
    assert.equal(result.absolute, scope.root);
    assert.ok(result.stat.isDirectory());
    assert.throws(() => assertFileMutationTarget(scope, result), {
      code: "FILE_PROTECTED_PATH",
    });
  }
  assert.equal((await resolveFile(f.globalScope, "~")).absolute, f.home);
  assert.equal((await resolveFile(f.globalScope, "~/project")).absolute, f.project);
});

test("parent revalidation catches replacements and alias retargeting while allowing unrelated siblings", async (t) => {
  const f = await fileFixture(t);
  const dir = path.join(f.project, "dir");
  await fs.mkdir(dir);
  const result = await resolveFile(f.projectScope, "dir/new", { allowMissingLeaf: true });
  await fs.writeFile(path.join(dir, "sibling"), "ok");
  await revalidateFileParent(f.projectScope, result);
  await fs.rename(dir, `${dir}-old`);
  await fs.mkdir(dir);
  await assert.rejects(revalidateFileParent(f.projectScope, result), {
    code: "FILE_PATH_CHANGED",
  });
  await fs.symlink("dir", path.join(f.project, "alias"));
  const viaAlias = await resolveFile(f.projectScope, "alias/new", {
    allowMissingLeaf: true,
  });
  await fs.unlink(path.join(f.project, "alias"));
  await fs.symlink("dir-old", path.join(f.project, "alias"));
  await assert.rejects(revalidateFileParent(f.projectScope, viaAlias), {
    code: "FILE_PATH_CHANGED",
  });
});

test("entry revisions detect metadata, nanoseconds and link identity but ignore access time", async (t) => {
  const f = await fileFixture(t);
  const file = path.join(f.project, "file");
  await fs.writeFile(file, "hello");
  const stat = await fs.stat(file, { bigint: true });
  const revision = entryRevision(stat);
  assert.match(revision, /^e1:[a-f0-9]+$/);
  assert.equal(entryRevision({ ...stat, atimeNs: stat.atimeNs + 1n }), revision);
  for (const field of ["dev", "ino", "mode", "uid", "gid", "size", "mtimeNs", "ctimeNs"])
    assert.notEqual(
      entryRevision({ ...stat, [field]: stat[field] + 1n }),
      revision,
      field,
    );
  assert.notEqual(entryRevision(stat, "link-a"), entryRevision(stat, "link-b"));
  assert.doesNotThrow(() => JSON.stringify({ revision }));
});

test("limits merge exact defaults and reject invalid override values and keys", () => {
  assert.deepEqual(readFileLimits(), {
    listPageSize: 200,
    listEntries: 100000,
    searchEntries: 100000,
    searchResults: 10000,
    searchMs: 30000,
    textBytes: 2097152,
    imageBytes: 20971520,
    uploadBytes: 10737418240,
    jobBytes: 53687091200,
    jobEntries: 50000,
    maxDepth: 128,
    transfers: 3,
    jobsRetentionMs: 604800000,
    uploadRetentionMs: 86400000,
  });
  assert.equal(readFileLimits({ textBytes: 17 }).textBytes, 17);
  assert.equal(readFileLimits().textBytes, 2097152);
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1", null])
    assert.throws(() => readFileLimits({ textBytes: value }), {
      code: "FILE_INVALID_LIMITS",
    });
  for (const value of [{ unknown: 1 }, null, [], "x"])
    assert.throws(() => readFileLimits(value), { code: "FILE_INVALID_LIMITS" });
});

test("loadConfig reads saved file limits only from an isolated data directory", async (t) => {
  const f = await fileFixture(t);
  const previous = process.env.AGENTPIER_DATA_DIR;
  process.env.AGENTPIER_DATA_DIR = f.dataDir;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTPIER_DATA_DIR;
    else process.env.AGENTPIER_DATA_DIR = previous;
  });
  assert.equal(loadConfig().files.limits.textBytes, 2097152);
  await fs.writeFile(
    path.join(f.dataDir, "config.json"),
    JSON.stringify({ files: { limits: { textBytes: 99 } } }),
  );
  assert.equal(loadConfig().files.limits.textBytes, 99);
  await fs.writeFile(
    path.join(f.dataDir, "config.json"),
    JSON.stringify({ files: { limits: { transfers: 0 } } }),
  );
  assert.throws(() => loadConfig(), { code: "FILE_INVALID_LIMITS" });
});

test("stable file issues retain public args and resolve reactive German and English copy", () => {
  const codes = [
    "FILE_OUTSIDE_SCOPE",
    "FILE_INVALID_PATH",
    "FILE_INVALID_NAME",
    "FILE_NOT_FOUND",
    "FILE_NOT_DIRECTORY",
    "FILE_LINK_LOOP",
    "FILE_ACCESS_DENIED",
    "FILE_IO_ERROR",
    "FILE_INVALID_SCOPE",
    "FILE_READ_ONLY",
    "FILE_PROTECTED_PATH",
    "FILE_PATH_CHANGED",
    "FILE_INVALID_LIMITS",
    "FILE_INVALID_PAGE",
    "FILE_INVALID_SORT",
    "FILE_SNAPSHOT_EXPIRED",
    "FILE_LIMIT_EXCEEDED",
    "FILE_UNSUPPORTED_TYPE",
  ];
  for (const code of codes) {
    const error = fileProblem(code, 403, { count: 2 });
    assert.equal(error.code, code);
    assert.equal(error.status, 403);
    assert.deepEqual(error.args, { count: 2 });
    assert.equal(error.message, "File operation failed.");
    setLanguage("en");
    assert.equal(typeof filesCopy.errors[code], "string");
    const english = filesCopy.errors[code];
    setLanguage("de");
    assert.notEqual(filesCopy.errors[code], english);
  }
});

test("leaf names reject control characters and enforce UTF-8 bytes without banning OS-valid punctuation", () => {
  for (const name of [
    "",
    ".",
    "..",
    "a/b",
    "x\0",
    "x\n",
    "x\u007f",
    "x\u0085",
    "ä".repeat(128),
  ])
    assert.throws(() => validateFileName(name), { code: "FILE_INVALID_NAME" });
  for (const name of ["a".repeat(255), "ä".repeat(127), "a\\b", " spaces ", ".hidden"])
    assert.equal(validateFileName(name), name);
});

test("scope construction preserves OS semantics in configured paths containing link-dot-dot", async (t) => {
  const f = await fileFixture(t);
  await fs.mkdir(path.join(f.home, "nested"));
  await fs.symlink(path.join(f.home, "nested"), path.join(f.project, "alias"));
  const scope = await makeFileScope({
    home: f.home,
    session: { id: "fixture", cwd: `${f.project}/alias/..` },
  });
  assert.equal(scope.root, f.home);
  await assert.rejects(
    makeFileScope({ home: f.home, session: { id: "fixture", cwd: 42 } }),
    { code: "FILE_INVALID_SCOPE" },
  );
});
