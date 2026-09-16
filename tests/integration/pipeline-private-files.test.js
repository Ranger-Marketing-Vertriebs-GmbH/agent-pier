import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { checkpointWorkspace } from "../../server/features/pipelines/workspace-checkpoint.js";
import { fixture } from "../helpers/pipeline-engine.js";

for (const state of ["new", "modified", "deleted"])
  test(`checkpoints unstage ${state} private files and preserve working contents`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-private-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" },
      }).trim();
    const privateFiles = [
      "upper/.ENV",
      "upper/.ENV.PRODUCTION",
      "upper/fixture.PEM",
      "upper/fixture.KEY",
      "nested/.env",
      "nested/.env.production",
      "nested/key.pem",
      "nested/key.key",
      "[literal]/.env",
      "nested/.env.*",
      ".pipeline/verdict.json",
      ".codex/auth.json",
    ];
    const write = (file, content) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), content);
    };
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    write("ordinary.txt", "base");
    if (state !== "new") for (const file of privateFiles) write(file, "FAKE_BASE");
    git("add", ".");
    git("commit", "-qm", "baseline");
    for (const file of privateFiles) {
      if (state === "deleted") fs.unlinkSync(path.join(dir, file));
      else write(file, "FAKE_CHANGED");
    }
    write("ordinary.txt", "changed");
    write("[literal]/ordinary.txt", "ordinary glob directory");
    git("add", "-A");
    const unstagedPrivateFiles = [
      "untracked/.ENV",
      "untracked/.ENV.LOCAL",
      "untracked/fixture.PEM",
      "untracked/fixture.KEY",
    ];
    for (const file of unstagedPrivateFiles) write(file, "FAKE_UNSTAGED");
    await checkpointWorkspace(
      { validate: async () => ({ cwd: dir, runId: "fixture" }) },
      { workspace: {} },
    );
    assert.deepEqual(git("diff", "HEAD^", "HEAD", "--name-only").split("\n"), [
      "[literal]/ordinary.txt",
      "ordinary.txt",
    ]);
    assert.equal(git("diff", "--cached", "--name-only"), "");
    for (const file of unstagedPrivateFiles)
      assert.equal(fs.readFileSync(path.join(dir, file), "utf8"), "FAKE_UNSTAGED");
    for (const file of privateFiles) {
      if (state === "deleted") assert.equal(fs.existsSync(path.join(dir, file)), false);
      else assert.equal(fs.readFileSync(path.join(dir, file), "utf8"), "FAKE_CHANGED");
    }
  });

test("declared private filenames at every depth are refused as artifacts", async (t) => {
  const f = fixture(t);
  const run = await f.engine.start({
    pipelineId: "definition",
    cwd: f.dir,
    task: "Task",
  });
  const privateFiles = [
    "upper/.ENV",
    "upper/.ENV.PRODUCTION",
    "upper/fixture.PEM",
    "upper/fixture.KEY",
    ".env",
    ".env.production",
    "key.pem",
    "key.key",
    "nested/.env",
    "nested/.env.production",
    "nested/key.pem",
    "nested/key.key",
    ".codex/auth.json",
  ];
  for (const file of [...privateFiles, "nested/report.txt"]) {
    fs.mkdirSync(path.dirname(path.join(run.workingDir, file)), { recursive: true });
    fs.writeFileSync(path.join(run.workingDir, file), "FAKE_CONTENT");
  }
  await f.end(
    {
      result: "pass",
      summary: "Done",
      artifacts: [...privateFiles, "nested/report.txt"],
    },
    { quiesced: true },
  );
  for (const file of privateFiles)
    assert.throws(() => f.engine.artifact(run.id, "build", file), { status: 403 });
  assert.equal(
    f.engine.artifact(run.id, "build", "nested/report.txt").text,
    "FAKE_CONTENT",
  );
});

test("case-insensitive aliases cannot expose private artifact contents", async (t) => {
  const f = fixture(t);
  const run = await f.engine.start({
    pipelineId: "definition",
    cwd: f.dir,
    task: "Task",
  });
  const files = [".env", ".env.production", "fixture.pem", "fixture.key"];
  for (const file of files)
    fs.writeFileSync(path.join(run.workingDir, file), "FAKE_ALIAS_CONTENT");
  if (!fs.existsSync(path.join(run.workingDir, ".ENV"))) {
    t.skip(
      "Filesystem is case-sensitive; uppercase filename policy is tested separately.",
    );
    return;
  }
  const aliases = files.map((file) => file.toUpperCase());
  await f.end(
    { result: "pass", summary: "Done", artifacts: aliases },
    { quiesced: true },
  );
  for (const file of aliases)
    assert.throws(() => f.engine.artifact(run.id, "build", file), { status: 403 });
});
