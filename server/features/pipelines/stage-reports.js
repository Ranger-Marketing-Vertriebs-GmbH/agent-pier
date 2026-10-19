import fs from "node:fs";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { privatePipelinePath } from "./private-paths.js";

// Stage reports (review findings, test reports) live in a run-private area beside the
// verdicts. Checkpoints never stage .pipeline/, so reports never reach the run branch;
// each attempt gets its own directory, so a loop-back never overwrites an earlier report.
const segment = /^[A-Za-z0-9_-]{1,100}$/;

export function reportDirectory(nodeId, attemptId) {
  if (!segment.test(nodeId) || !segment.test(attemptId))
    throw problem(serverMessages.pipelines.invalidTurn);
  return `.pipeline/reports/${nodeId}/${attemptId}`;
}

// Creates the attempt's report directory without following links an agent may have planted.
export function prepareReportDirectory(cwd, nodeId, attemptId) {
  const relative = reportDirectory(nodeId, attemptId);
  let directory = cwd;
  for (const part of relative.split("/")) {
    directory = path.join(directory, part);
    try {
      const st = fs.lstatSync(directory);
      if (!st.isDirectory() || st.isSymbolicLink())
        throw problem(serverMessages.pipelines.unsafeVerdictDirectory, 409);
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

// The newest finished attempt of every stage that declared reports in its own report
// directory: what a later stage (repair, review, approval) is handed to read.
export function latestStageReports(run) {
  const latest = new Map();
  for (const attempt of run.executionLog) {
    if (!attempt.finishedAt || !attempt.reportDir) continue;
    const reports = (attempt.verdict?.artifacts || []).filter((artifact) =>
      stageReportPath({ executionLog: [attempt] }, attempt.nodeId, artifact.path),
    );
    if (reports.length)
      latest.set(attempt.nodeId, {
        nodeId: attempt.nodeId,
        attemptId: attempt.attemptId,
        reportDir: attempt.reportDir,
        reports,
      });
  }
  return [...latest.values()];
}
