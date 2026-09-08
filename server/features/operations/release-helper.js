import { isMainModule } from "../../lib/is-main-module.js";
import path from "node:path";
import fs from "node:fs";
import { activateRelease } from "./release-activation.js";
import { readJson, atomic, identifier } from "./files.js";
import { AuditStore } from "../audit/audit-store.js";
function recordOutcome(input, job, outcome) {
  let audit;
  try {
    audit = new AuditStore({ dataDir: input.dataDir });
    audit.append({
      action:
        outcome === "failure"
          ? "release.failed"
          : job.kind === "release-rollback"
            ? "release.rolled-back"
            : "release.activated",
      resourceType: "release",
      resourceId: job.id,
      outcome,
      source: "user",
    });
  } catch {
  } finally {
    audit?.close();
  }
}
export async function runReleaseHelper(requestFile) {
  const input = readJson(requestFile);
  const jobFile = path.join(
    input.dataDir,
    "operations/jobs",
    `${identifier(input.jobId)}.json`,
  );
  const job = readJson(jobFile);
  const pulse = () => atomic(jobFile, { ...job, heartbeatAt: new Date().toISOString() });
  pulse();
  const heartbeat = setInterval(pulse, 1000);
  try {
    try {
      const response = await fetch(`http://127.0.0.1:${input.port || 4380}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      const current = await response.json();
      if (current.application === "agentpier")
        input.previousInstanceId = current.instanceId;
    } catch {}
    const result = await activateRelease(input);
    clearInterval(heartbeat);
    atomic(jobFile, {
      ...job,
      status: "succeeded",
      result,
      finishedAt: new Date().toISOString(),
    });
    recordOutcome(input, job, "success");
  } catch (error) {
    clearInterval(heartbeat);
    atomic(jobFile, {
      ...job,
      status: "failed",
      error: error.status
        ? error.message
        : "Release activation failed before a verified outcome.",
      ...(error.result ? { result: error.result } : {}),
      finishedAt: new Date().toISOString(),
    });
    recordOutcome(input, job, "failure");
  } finally {
    clearInterval(heartbeat);
    fs.rmSync(requestFile, { force: true });
  }
}
if (isMainModule(import.meta.url)) await runReleaseHelper(process.argv[2]);
