import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  MAX_SHARE_BYTES,
  readShareSource,
  shareRoots,
} from "../../server/features/assistants/agent-share-source.js";

function workspace(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-share-source-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "workspaces", "agent-1");
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  fs.writeFileSync(path.join(root, "reports", "summary.txt"), "Summary\n");
  fs.writeFileSync(path.join(base, "secret.txt"), "outside");
  return {
    base,
    root,
    roots: shareRoots(path.join(base, "workspaces"), { id: "agent-1" }),
  };
}

test("the agent's own workspace is the only share root", () => {
  assert.deepEqual(shareRoots("/data/workspaces", { id: "a1" }), [
    path.join("/data/workspaces", "a1"),
  ]);
  assert.deepEqual(shareRoots(null, { id: "a1" }), []);
});

test("a file inside the workspace is read by relative or absolute path", async (t) => {
  const { root, roots } = workspace(t);
  const relative = await readShareSource(roots, "reports/summary.txt");
  assert.equal(relative.name, "summary.txt");
  assert.equal(relative.body.toString(), "Summary\n");
  const absolute = await readShareSource(roots, path.join(root, "reports/summary.txt"));
  assert.equal(absolute.body.toString(), "Summary\n");
  const real = await readShareSource(
    roots,
    path.join(fs.realpathSync(root), "./reports/../reports/summary.txt"),
  );
  assert.equal(real.name, "summary.txt");
});

test("traversal and absolute paths outside the workspace are refused", async (t) => {
  const { base, roots } = workspace(t);
  for (const target of [
    "../../secret.txt",
    "reports/../../../secret.txt",
    path.join(base, "secret.txt"),
    "/etc/hosts",
    ".",
    "",
  ])
    await assert.rejects(readShareSource(roots, target), (error) =>
      [403, 400].includes(error.status),
    );
  await assert.rejects(readShareSource(roots, "reports/a\nb.txt"), { status: 400 });
  await assert.rejects(readShareSource(roots, "reports\u0000x"), { status: 400 });
});

test("symbolic links, linked folders and hard links never reach outside files", async (t) => {
  const { base, root, roots } = workspace(t);
  fs.symlinkSync(path.join(base, "secret.txt"), path.join(root, "link.txt"));
  fs.symlinkSync(base, path.join(root, "outside"));
  // Even a link that stays inside the workspace is refused: no link is followed.
  fs.symlinkSync(path.join(root, "reports"), path.join(root, "inner"));
  fs.linkSync(path.join(base, "secret.txt"), path.join(root, "hard.txt"));
  for (const target of [
    "link.txt",
    "outside/secret.txt",
    "inner/summary.txt",
    "hard.txt",
  ])
    await assert.rejects(readShareSource(roots, target), { status: 403 }, target);
});

test("a workspace that is itself a link shares nothing outside it", async (t) => {
  const { base } = workspace(t);
  const workspaces = path.join(base, "linked");
  fs.mkdirSync(workspaces);
  fs.symlinkSync(base, path.join(workspaces, "agent-2"));
  const roots = shareRoots(workspaces, { id: "agent-2" });
  for (const target of ["secret.txt", path.join(workspaces, "agent-2", "secret.txt")])
    await assert.rejects(readShareSource(roots, target), { status: 403 }, target);
});

test("missing files, folders, special files, empty and oversized files are refused", async (t) => {
  const { root, roots } = workspace(t);
  await assert.rejects(readShareSource(roots, "missing.pdf"), { status: 404 });
  await assert.rejects(readShareSource(roots, "reports/summary.txt/x"), { status: 404 });
  await assert.rejects(readShareSource(roots, "reports"), { status: 404 });
  fs.writeFileSync(path.join(root, "empty.txt"), "");
  await assert.rejects(readShareSource(roots, "empty.txt"), { status: 400 });
  fs.writeFileSync(path.join(root, "big.bin"), Buffer.alloc(64));
  await assert.rejects(readShareSource(roots, "big.bin", { maxBytes: 63 }), {
    status: 413,
  });
  assert.equal(
    (await readShareSource(roots, "big.bin", { maxBytes: 64 })).body.length,
    64,
  );
  assert.equal(MAX_SHARE_BYTES, 25 * 1024 * 1024);
  execFileSync("mkfifo", [path.join(root, "pipe")]);
  await assert.rejects(readShareSource(roots, "pipe"), { status: 403 });
});
