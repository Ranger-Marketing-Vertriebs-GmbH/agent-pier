import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PipelineEngine } from "../../server/features/pipelines/pipeline-engine.js";

export function fixture(
  t,
  { gate = false, loop = false, verification = false, verify, clock } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-pipeline-engine-"));
  const launches = [],
    outcomes = new Map();
  const profile = {
    id: "profile",
    name: "Builder",
    config: {
      cliTool: "codex",
      accountId: "local-codex",
      prompts: { kickoff: "Perform {{task}}", role: "" },
      models: { default: "" },
      permissions: { mode: "default" },
      run: { autonomous: true },
    },
  };
  const graph = {
    entry: "build",
    nodes: [
      { id: "build", kind: "profile", profileId: "profile" },
      ...(gate ? [{ id: "gate", kind: "gate" }] : []),
    ],
    edges: gate ? [{ from: "build", to: "gate", condition: "default" }] : [],
  };
  if (loop) {
    graph.nodes.push({ id: "review", kind: "profile", profileId: "profile" });
    graph.edges.push(
      { from: "build", to: "review", condition: "default" },
      { from: "review", to: "build", condition: "fail", maxIterations: 1 },
    );
  }
  if (verification) {
    graph.nodes.push({ id: "verify", kind: "verify" });
    graph.edges.push({
      from: gate ? "gate" : "build",
      to: "verify",
      condition: "default",
    });
  }
  const definitions = {
    snapshot: () => ({
      pipeline: { id: "definition", name: "Test", graph },
      profiles: { profile },
    }),
    getVerification: () => ({ steps: [] }),
  };
  const driver = {
    async start(input) {
      launches.push(input);
      outcomes.set(input.sessionId, { status: "running" });
      return { sessionId: input.sessionId };
    },
    async inspect(input) {
      return outcomes.get(input.sessionId) || { status: "missing" };
    },
    async cancel(input) {
      outcomes.set(input.sessionId, { status: "failed", exitCode: 130 });
    },
  };
  const workspace = {
    async prepare({ runId }) {
      const cwd = path.join(dir, runId);
      fs.mkdirSync(cwd);
      return {
        cwd,
        projectRoot: dir,
        projectId: "project",
        branch: "agentpier/" + runId,
        baseSha: "abc",
      };
    },
    async remove() {
      throw Error("unexpected cleanup");
    },
  };
  const make = () =>
    new PipelineEngine({
      dataDir: dir,
      definitions,
      driver,
      workspace,
      pollIntervalMs: 0,
      ...(verify ? { verify } : {}),
      ...(clock ? { clock } : {}),
    });
  let engine = make();
  t.after(async () => {
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function end(verdict = { result: "pass", summary: "Done" }, extra = {}) {
    const l = launches.at(-1);
    fs.writeFileSync(path.join(l.cwd, l.verdictPath), JSON.stringify(verdict));
    outcomes.set(l.sessionId, { status: "completed", exitCode: 0, ...extra });
    await engine.reconcile();
  }
  return {
    dir,
    launches,
    outcomes,
    definitions,
    driver,
    workspace,
    get engine() {
      return engine;
    },
    end,
    async restart() {
      await engine.close();
      engine = make();
      await engine.recover();
    },
  };
}
