import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  reportDirectory,
  prepareReportDirectory,
  stageReportPath,
  latestStageReports,
} from "../../server/features/pipelines/stage-reports.js";
import { artifactText } from "../../server/features/pipelines/artifact-reader.js";
import { privatePipelinePath } from "../../server/features/pipelines/private-paths.js";
import { seedProfiles } from "../../server/features/pipelines/profile-seeds.js";

function workdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-reports-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(dir, file, content) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}
function attempt(nodeId, attemptId, artifacts, extra = {}) {
  return {
    id: `turn-${attemptId}`,
    nodeId,
    attemptId,
    verdictPath: `.pipeline/turns/turn-${attemptId}/verdict.json`,
    reportDir: reportDirectory(nodeId, attemptId),
    startedAt: "2026-10-19T10:00:00Z",
    finishedAt: "2026-10-19T10:05:00Z",
    verdict: { result: "pass", summary: "Done", findings: [], artifacts },
    ...extra,
  };
}

test("report directories are scoped per stage and attempt inside the private area", () => {
  assert.equal(reportDirectory("review", "a1"), ".pipeline/reports/review/a1");
  assert.equal(privatePipelinePath(reportDirectory("review", "a1") + "/REVIEW.md"), true);
  for (const [nodeId, attemptId] of [
    ["../x", "a"],
    ["review", "a/b"],
    ["", "a"],
    ["review", ".."],
  ])
    assert.throws(() => reportDirectory(nodeId, attemptId), { status: 400 });
});

test("the report directory is created privately and refuses planted links", (t) => {
  const dir = workdir(t);
  const relative = prepareReportDirectory(dir, "review", "a1");
  assert.equal(relative, ".pipeline/reports/review/a1");
  assert.equal(fs.statSync(path.join(dir, relative)).isDirectory(), true);
  assert.equal(prepareReportDirectory(dir, "review", "a1"), relative);
  const other = workdir(t);
  fs.symlinkSync(other, path.join(dir, ".pipeline/reports/linked"));
  assert.throws(() => prepareReportDirectory(dir, "linked", "a1"), { status: 409 });
  assert.deepEqual(fs.readdirSync(other), []);
});

test("only files inside this stage's recorded report directories count as reports", () => {
  const run = {
    executionLog: [attempt("review", "a1", []), attempt("build", "b1", [])],
  };
  const dir = ".pipeline/reports/review/a1";
  assert.equal(stageReportPath(run, "review", `${dir}/REVIEW.md`), true);
  assert.equal(stageReportPath(run, "review", `${dir}/nested/notes.md`), true);
  assert.equal(stageReportPath(run, "review", `${dir}/`), false);
  assert.equal(stageReportPath(run, "review", `${dir}/.env`), false);
  assert.equal(stageReportPath(run, "review", `${dir}/nested/key.pem`), false);
  assert.equal(stageReportPath(run, "review", ".pipeline/reports/build/b1/x.md"), false);
  assert.equal(stageReportPath(run, "review", ".pipeline/reports/review/zz/x.md"), false);
  assert.equal(stageReportPath(run, "review", ".PIPELINE/reports/review/a1/x.md"), false);
  assert.equal(
    stageReportPath(run, "review", ".pipeline/turns/turn-a1/verdict.json"),
    false,
  );
  // Attempts recorded before report directories existed grant nothing.
  const legacy = {
    executionLog: [{ ...attempt("review", "a1", []), reportDir: undefined }],
  };
  assert.equal(stageReportPath(legacy, "review", `${dir}/REVIEW.md`), false);
});

test("declared reports are readable while verdicts, turn files and other private files stay denied", (t) => {
  const dir = workdir(t);
  const reportDir = prepareReportDirectory(dir, "review", "a1");
  const files = {
    report: `${reportDir}/REVIEW.md`,
    verdict: ".pipeline/turns/turn-a1/verdict.json",
    turn: ".pipeline/turns/turn-a1/notes.md",
    other: ".pipeline/reports/build/b1/PLAN.md",
    secret: `${reportDir}/.env`,
    task: ".pipeline/task.md",
  };
  for (const file of Object.values(files)) write(dir, file, `content of ${file}`);
  const run = {
    workingDir: dir,
    nodes: [{ id: "review" }, { id: "build" }],
    executionLog: [
      attempt(
        "review",
        "a1",
        Object.values(files).map((p) => ({ path: p })),
      ),
    ],
  };
  assert.deepEqual(artifactText(run, "review", files.report), {
    text: `content of ${files.report}`,
    truncated: false,
  });
  for (const key of ["verdict", "turn", "other", "secret", "task"])
    assert.throws(() => artifactText(run, "review", files[key]), { status: 403 }, key);
  // An undeclared report is not evidence, even inside the report directory.
  write(dir, `${reportDir}/UNDECLARED.md`, "x");
  assert.throws(() => artifactText(run, "review", `${reportDir}/UNDECLARED.md`), {
    status: 404,
  });
});

test("report reads keep the containment, symlink and size rules", (t) => {
  const dir = workdir(t);
  const reportDir = prepareReportDirectory(dir, "review", "a1");
  write(dir, ".pipeline/turns/t/verdict.json", "{}");
  fs.symlinkSync(
    path.join(dir, ".pipeline/turns/t/verdict.json"),
    path.join(dir, reportDir, "link.md"),
  );
  write(dir, `${reportDir}/big.md`, "x".repeat(2 * 1024 * 1024 + 10));
  const run = {
    workingDir: dir,
    nodes: [{ id: "review" }],
    executionLog: [
      attempt("review", "a1", [
        { path: `${reportDir}/link.md` },
        { path: `${reportDir}/big.md` },
        { path: `${reportDir}/missing.md` },
      ]),
    ],
  };
  assert.throws(() => artifactText(run, "review", `${reportDir}/link.md`), {
    status: 403,
  });
  const big = artifactText(run, "review", `${reportDir}/big.md`);
  assert.equal(big.truncated, true);
  assert.equal(big.text.length, 2 * 1024 * 1024);
  assert.throws(() => artifactText(run, "review", `${reportDir}/missing.md`), {
    status: 404,
  });
});

test("latest reports name the newest finished attempt of every stage", () => {
  const report = (nodeId, attemptId, name) => ({
    path: `${reportDirectory(nodeId, attemptId)}/${name}`,
  });
  const run = {
    executionLog: [
      attempt("build", "b1", [{ path: "app.js" }]),
      attempt("review", "r1", [report("review", "r1", "REVIEW.md"), { path: "x.md" }]),
      attempt("build", "b2", []),
      attempt("review", "r2", [{ ...report("review", "r2", "REVIEW.md"), label: "R" }]),
      attempt("security", "s1", [report("security", "s1", "SECURITY.md")], {
        finishedAt: undefined,
      }),
    ],
  };
  assert.deepEqual(latestStageReports(run), [
    {
      nodeId: "review",
      attemptId: "r2",
      reportDir: ".pipeline/reports/review/r2",
      reports: [{ path: ".pipeline/reports/review/r2/REVIEW.md", label: "R" }],
    },
  ]);
});

test("seed reviewers write their reports into the stage report directory", () => {
  const roles = Object.fromEntries(
    seedProfiles("2026-10-19T00:00:00Z").map((p) => [p.seedKey, p.config.prompts.role]),
  );
  for (const [key, file] of [
    ["code-reviewer", "REVIEW.md"],
    ["security-reviewer", "SECURITY.md"],
    ["app-tester", "TEST-REPORT.md"],
  ])
    assert.match(
      roles[key],
      new RegExp(`${file.replace(".", "\\.")} in the stage report directory`),
    );
});
