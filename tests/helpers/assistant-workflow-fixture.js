import fs from "node:fs";
import path from "node:path";
import { channelFixture } from "./assistant-channel-fixture.js";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { McpTools } from "../../server/features/mcp/tool-service.js";
import { MutationBarrier } from "../../server/application/mutation-barrier.js";
import { AssistantWorkflows } from "../../server/features/assistants/assistant-workflows.js";
export async function workflowFixture(t) {
  const f = channelFixture(t),
    runs = new Map(),
    starts = [];
  const memory = new ProjectMemory({ dataDir: f.dataDir });
  const cwd = path.join(f.dataDir, "project");
  fs.mkdirSync(cwd);
  const project = await memory.register(cwd);
  const profile = {
    id: "profile",
    name: "Coder",
    revision: 1,
    config: { accountId: "account", cliTool: "codex", models: { default: "model" } },
  };
  const pipeline = {
    id: "pipeline",
    name: "Build",
    revision: 1,
    graph: {
      entry: "code",
      nodes: [{ id: "code", kind: "profile", profileId: "profile" }],
      edges: [],
    },
  };
  const services = {
    config: { dataDir: f.dataDir },
    assistants: f.assistants,
    assistantChannels: f.service,
    memory,
    mutationBarrier: new MutationBarrier(),
    audit: { append() {} },
    pipelineDefinitions: {
      listPipelines: () => [pipeline],
      getPipeline: () => structuredClone(pipeline),
      getProfile: () => structuredClone(profile),
    },
    pipelines: {
      get: (id) => {
        if (!runs.has(id)) throw Object.assign(Error(), { status: 404 });
        return runs.get(id);
      },
      async start(input, options) {
        starts.push(input);
        const run = {
          id: options.id,
          pipelineId: pipeline.id,
          pipelineName: pipeline.name,
          projectId: project.id,
          status: "running",
          phase: "running",
          nodes: [
            { id: "code", status: "running", profileSnapshot: structuredClone(profile) },
          ],
        };
        runs.set(run.id, run);
        return run;
      },
      async cancel(id) {
        runs.get(id).status = "cancelled";
        return runs.get(id);
      },
    },
  };
  services.mcpTools = new McpTools(services);
  f.assistants.admit = async (fn) => fn();
  f.assistants.serialize = async (_key, fn) => fn();
  const contexts = new Map();
  f.assistants.teams = {
    store: { context: (id) => contexts.get(id) || { kind: "owner" } },
  };
  const workflows = new AssistantWorkflows({ services, autoStart: false });
  f.assistants.workflows = workflows;
  t.after(async () => {
    await workflows.close();
    services.mcpTools.close();
    memory.close();
  });
  const id = f.channel.assistantId;
  const policy = {
    projectIds: [project.id],
    pipelineIds: [pipeline.id],
    memoryWrite: true,
    autonomous: false,
    publish: false,
  };
  async function invocation(key = crypto.randomUUID(), origin = { kind: "owner" }) {
    const sent = await f.assistants.send(f.channel.conversationId, {
      clientRequestId: key,
      text: "Test assignment",
    });
    contexts.set(sent.request.id, origin);
    return { attemptId: sent.attempt.id, toolCallId: key, assertCurrent() {} };
  }
  return {
    ...f,
    id,
    services,
    workflows,
    memory,
    project,
    profile,
    pipeline,
    policy,
    runs,
    starts,
    invocation,
  };
}
