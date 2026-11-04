import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import express from "express";
import { PipelineWorkspace } from "../../server/features/pipelines/workspace-manager.js";
import { runDiff } from "../../server/features/pipelines/run-diff.js";
import { pipelineRunRoutes } from "../../server/http/routes/pipeline-runs.js";
import { routeAccess } from "../../server/http/route-access.js";
import { registerResponses } from "../../server/http/responses.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

// Every test builds its own repository, run worktree and engine stand-in.
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-run-diff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(root, "data"));
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  git(project, "init", "-b", "main");
  git(project, "config", "user.name", "Fixture");
  git(project, "config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(project, "tracked.txt"), "base\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "base");
  const manager = new PipelineWorkspace({ dataDir: path.join(root, "data") });
  const stored = await manager.prepare({
    runId: "run-1",
    cwd: project,
    baseBranch: "main",
  });
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(stored.cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(stored.cwd, file), text);
  };
  const commit = (file, text) => {
    write(file, text);
    git(stored.cwd, "add", file);
    git(stored.cwd, "commit", "-m", `add ${file}`);
  };
  const engine = { workspace: manager };
  return { root, manager, stored, write, commit, engine, git };
}

test("the run diff spans every stage since the base commit", async (t) => {
  const { manager, stored, commit } = await fixture(t);
  commit("a.js", "one\n");
  commit("b.js", "two\n");
  const result = await manager.runDiff({ workspace: stored });
  assert.equal(result.from, stored.baseSha);
  assert.deepEqual(
    result.files.map((f) => f.path),
    ["a.js", "b.js"],
  );
  assert.equal(result.truncated, false);
  assert.match(result.fingerprint, /^[0-9a-f]{16}$/);
});

test("uncommitted work shows, the run area never", async (t) => {
  const { manager, stored, write } = await fixture(t);
  write("c.js", "new\n");
  write(".pipeline/reports/build/1/REVIEW.md", "x\n");
  const paths = (await manager.runDiff({ workspace: stored })).files.map((f) => f.path);
  assert.ok(paths.includes("c.js"));
  assert.ok(!paths.some((p) => p.startsWith(".pipeline/")));
});

test("an edit that keeps the line counts changes the fingerprint", async (t) => {
  const { manager, stored, write } = await fixture(t);
  write("c.js", "aaa\n");
  const before = await manager.runDiff({ workspace: stored });
  await new Promise((resolve) => setTimeout(resolve, 15));
  write("c.js", "bbbb\n");
  const after = await manager.runDiff({ workspace: stored });
  assert.notEqual(after.fingerprint, before.fingerprint);
});

test("the fingerprint is read before the diff", async (t) => {
  // An edit between the two reads may only pair a newer diff with an older
  // fingerprint (the next read replaces it), never an old diff with a new fingerprint.
  const { root, manager, stored, write } = await fixture(t);
  write("c.js", "aaa\n");
  const bin = path.join(root, "bin");
  const log = path.join(root, "git.log");
  fs.mkdirSync(bin);
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\necho "start $*" >> "${log}"\n"${real}" "$@"\nstatus=$?\necho "end $*" >> "${log}"\nexit $status\n`,
    { mode: 0o755 },
  );
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  t.after(() => (process.env.PATH = before));
  await manager.runDiff({ workspace: stored });
  const calls = fs.readFileSync(log, "utf8").split("\n");
  // the fingerprint's numstat ends before the diff itself starts
  const statEnd = calls.findIndex((line) => /^end .* diff .*--numstat/.test(line));
  const diffStart = calls.findIndex(
    (line) => /^start .* diff /.test(line) && !line.includes("--numstat"),
  );
  assert.ok(statEnd >= 0 && diffStart >= 0, calls.join("\n"));
  assert.ok(statEnd < diffStart, calls.join("\n"));
});

test("a removed workspace or a run without one is refused", async (t) => {
  const { manager, stored, engine } = await fixture(t);
  await manager.remove({ workspace: stored });
  await assert.rejects(manager.runDiff({ workspace: stored }), {
    status: 409,
    code: "PIPELINE_RUN_WORKSPACE_GONE",
  });
  await assert.rejects(runDiff(engine, { workspace: undefined }), {
    status: 409,
    code: "PIPELINE_RUN_WORKSPACE_GONE",
    message: serverMessages.changes.runWithoutWorkspace,
  });
  await assert.rejects(runDiff(engine, { imported: { historyOnly: true } }), {
    status: 409,
    code: "PIPELINE_RUN_IMPORTED",
  });
});

test("the per-stage diff is bounded without failing over the buffer", async (t) => {
  const { manager, stored, write } = await fixture(t);
  write("big.txt", "x".repeat(40) + "\n");
  fs.writeFileSync(
    path.join(stored.cwd, "tracked.txt"),
    "line\n".repeat(400000), // about 2 MB of changes
  );
  const result = await manager.diff({ workspace: stored });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.diff) <= 1048576);
  assert.ok(result.diff.endsWith("\n"), "no mid-line cut");
});

async function serve(t, { runs, engine }) {
  const app = express();
  app.use((req, _res, next) => {
    req.principal = req.query.as === "user" ? { role: "user", userId: "u" } : null;
    next();
  });
  app.use("/api", routeAccess());
  const pipelines = {
    runDiff: async (id) => {
      const run = runs[id];
      if (!run) throw Object.assign(new Error("missing"), { status: 404 });
      return runDiff(engine, run);
    },
  };
  app.use("/api", pipelineRunRoutes({ pipelines, pipelineRunCounts: {} }));
  registerResponses(app);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => server.close());
  return async (url) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
    return { status: response.status, body: await response.json() };
  };
}

test("the route answers parsed files with the cap flag and refuses restricted users", async (t) => {
  const { stored, commit, engine } = await fixture(t);
  commit("a.js", "one\n");
  const get = await serve(t, { runs: { r1: { workspace: stored } }, engine });
  const { status, body } = await get("/api/pipeline-runs/r1/diff");
  assert.equal(status, 200);
  assert.equal(body.truncated, false);
  assert.deepEqual(
    body.files.map((f) => f.path),
    ["a.js"],
  );
  assert.equal(typeof body.fingerprint, "string");
  assert.equal(JSON.stringify(body).includes(os.tmpdir()), false, "no host paths");
  assert.equal((await get("/api/pipeline-runs/r1/diff?as=user")).status, 404);
});

test("the route signals a missing workspace by its code", async (t) => {
  const { engine } = await fixture(t);
  const get = await serve(t, {
    runs: { bare: {}, old: { imported: { historyOnly: true } } },
    engine,
  });
  const bare = await get("/api/pipeline-runs/bare/diff");
  assert.deepEqual([bare.status, bare.body.code], [409, "PIPELINE_RUN_WORKSPACE_GONE"]);
  const old = await get("/api/pipeline-runs/old/diff");
  assert.deepEqual([old.status, old.body.code], [409, "PIPELINE_RUN_IMPORTED"]);
});
