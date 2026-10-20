import fs from "node:fs";
import path from "node:path";
import { fixture } from "./pipeline-engine.js";

// build -> review (parallel: security, code) with a bounded loop back to build.
export function groupFixture(t, { concurrency, loop = true, members, options } = {}) {
  const f = fixture(t, { options });
  const original = f.definitions.snapshot;
  const ids = members || ["security", "code"];
  f.definitions.snapshot = () => {
    const snapshot = original();
    const base = snapshot.profiles.profile;
    for (const id of ids)
      snapshot.profiles[id] = {
        ...base,
        id,
        name: `${id[0].toUpperCase()}${id.slice(1)}`,
      };
    snapshot.pipeline.graph = {
      entry: "build",
      nodes: [
        { id: "build", kind: "profile", profileId: "profile" },
        {
          id: "review",
          kind: "parallel",
          members: ids.map((id) => ({ id, profileId: id })),
          ...(concurrency ? { concurrency } : {}),
        },
      ],
      edges: [
        { from: "build", to: "review", condition: "default" },
        ...(loop
          ? [{ from: "review", to: "build", condition: "fail", maxIterations: 2 }]
          : []),
      ],
    };
    return snapshot;
  };
  // Ends the newest turn of `nodeId` with a verdict (or none) and reconciles once.
  async function finish(nodeId, verdict, extra = {}) {
    const launch = f.launches.findLast((l) => l.nodeId === nodeId);
    if (verdict) {
      const file = path.join(launch.cwd, launch.verdictPath);
      fs.writeFileSync(file, JSON.stringify(verdict));
      const at = Math.ceil(f.engine.nowMs() / 1000);
      fs.utimesSync(file, at, at);
    }
    f.outcomes.set(launch.sessionId, { status: "completed", exitCode: 0, ...extra });
    await f.engine.reconcile();
  }
  const start = () =>
    f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Change the app" });
  return { f, finish, start };
}
export const pass = (summary = "Fine", findings = []) => ({
  result: "pass",
  summary,
  findings,
});
export const fail = (title, severity = "high") => ({
  result: "fail",
  summary: `Found ${title}`,
  findings: [{ severity, title }],
});
