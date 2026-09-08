import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SessionProjects } from "../../server/features/sessions/session-projects.js";

test("session labels identify a repository from subdirectories and preserve non-repo paths", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-projects-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "example-repo");
  const cwd = path.join(repo, "src");
  await fs.mkdir(cwd, { recursive: true });
  execFileSync("git", ["init", "--quiet", repo]);
  const sessions = [{ cwd }, { cwd: root }, { cwd: path.join(root, "missing") }];
  const result = await new SessionProjects().enrich(sessions);
  assert.equal(result[0].repositoryName, "example-repo");
  assert.equal(result[0].cwd, cwd);
  assert.equal(result[1].repositoryName, null);
  assert.equal(result[1].cwd, root);
  assert.equal(result[2].repositoryName, null);
  assert.equal(sessions[0].repositoryName, undefined);
});
