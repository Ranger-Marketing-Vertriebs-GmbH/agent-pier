import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { privatePipelinePath } from "./private-paths.js";
import { containedFile } from "./stage-verdict.js";

// Stage reports (review findings, test reports) live in a run-private area beside the
// verdicts. Checkpoints never stage .pipeline/, so reports never reach the run branch;
// each attempt gets its own directory, so a loop-back never overwrites an earlier report.
const segment = /^[A-Za-z0-9_-]{1,100}$/;
export const REPORT_READ_LIMIT = 2 * 1024 * 1024;

// A kickoff writes into its attempt's directory; a feedback or verification-repair turn
// of the same attempt gets a subdirectory of its own, so an earlier turn's declared
// report stays as it was.
export function reportDirectory(nodeId, attemptId, turnId) {
  const parts = [nodeId, attemptId, ...(turnId === undefined ? [] : [turnId])];
  if (!parts.every((part) => segment.test(part)))
    throw problem(serverMessages.pipelines.invalidTurn);
  return `.pipeline/reports/${parts.join("/")}`;
}

// Creates a report directory without following links an agent may have planted.
export function prepareReportDirectory(cwd, relative) {
  let directory = cwd;
  for (const part of relative.split("/")) {
    directory = path.join(directory, part);
    try {
      const st = fs.lstatSync(directory);
      if (!st.isDirectory() || st.isSymbolicLink())
        throw problem(serverMessages.pipelines.unsafeReportDirectory, 409);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      fs.mkdirSync(directory, { mode: 0o700 });
    }
  }
  return relative;
}

// A declared file is a readable report only inside a report directory recorded for an
// attempt of this stage, and only when its name inside that directory is not private.
export function stageReportPath(run, nodeId, file) {
  if (typeof file !== "string") return false;
  return run.executionLog.some((attempt) => {
    if (attempt.nodeId !== nodeId || typeof attempt.reportDir !== "string") return false;
    const prefix = `${attempt.reportDir}/`;
    if (!file.startsWith(prefix)) return false;
    const inner = file.slice(prefix.length);
    return Boolean(inner) && !privatePipelinePath(inner);
  });
}

// Declared files of a finished turn that lie in its stage's private report area.
export const stageReports = (run, attempt) =>
  (attempt.verdict?.artifacts || []).filter((artifact) =>
    stageReportPath(run, attempt.nodeId, artifact.path),
  );

// The newest finished turn with a verdict decides a stage's current reports (a turn
// without one, e.g. before a verdict nudge, declared nothing): a later round
// without reports supersedes an earlier round's, so a stale report is never handed on.
export function latestStageReports(run) {
  const latest = new Map();
  for (const attempt of run.executionLog)
    if (attempt.finishedAt && attempt.verdict) latest.set(attempt.nodeId, attempt);
  return [...latest.values()].flatMap((attempt) => {
    const reports = stageReports(run, attempt);
    return reports.length
      ? [
          {
            nodeId: attempt.nodeId,
            attemptId: attempt.attemptId,
            reportDir: attempt.reportDir,
            reports,
          },
        ]
      : [];
  });
}

const fingerprint = (read) => ({
  size: read.size,
  sha256: createHash("sha256").update(read.data).digest("hex"),
});

// Size and hash of each declared report when its turn finishes, so a later rewrite is
// visible to everyone who reads it.
export function recordReportDigests(run, attempt) {
  const digests = {};
  for (const { path: file } of stageReports(run, attempt)) {
    try {
      digests[file] = fingerprint(containedFile(run.workingDir, file, REPORT_READ_LIMIT));
    } catch {
      // A missing or unreadable report has nothing to vouch for.
    }
  }
  if (Object.keys(digests).length) attempt.reportDigests = digests;
}

// True when a report no longer matches what the newest turn declaring it recorded.
export function reportChanged(run, nodeId, file, read) {
  const recorded = run.executionLog.findLast(
    (a) => a.nodeId === nodeId && a.finishedAt && a.reportDigests?.[file],
  )?.reportDigests[file];
  if (!recorded) return false;
  const now = fingerprint(read);
  return now.size !== recorded.size || now.sha256 !== recorded.sha256;
}
