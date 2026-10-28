import { PipelineDefinitions } from "../features/pipelines/pipeline-definitions.js";
import { PipelineEngine } from "../features/pipelines/pipeline-engine.js";
import { NativePipelineDriver } from "../features/pipelines/native-driver.js";
import { PipelineWorkspace } from "../features/pipelines/workspace-manager.js";
import { RunQueue } from "../features/pipelines/run-queue.js";
import { RunCounts } from "../features/pipelines/run-counts.js";
import {
  pipelineListsChanged,
  pipelineQueueChanged,
  pipelineRunChanged,
} from "../features/pipelines/live-topics.js";
import { agentRunChanged } from "../features/assistants/live-topics.js";

export async function createPipelineServices(services) {
  const { config, accounts, sessions, chat, github, tools, memory, launch } = services;
  const pipelineDefinitions = new PipelineDefinitions({
    dataDir: config.dataDir,
    accounts,
  });
  const pipelineDriver = new NativePipelineDriver({
    dataDir: config.dataDir,
    accounts,
    sessions,
    chat,
    lifecycle: { launch },
  });
  const pipelineWorkspace = new PipelineWorkspace({
    dataDir: config.dataDir,
    github,
    accounts,
    tools,
    memory,
    sessions,
  });
  const pipelineRunCounts = new RunCounts();
  const pipelines = new PipelineEngine({
    dataDir: config.dataDir,
    definitions: pipelineDefinitions,
    driver: pipelineDriver,
    workspace: pipelineWorkspace,
    mutationBarrier: services.mutationBarrier,
    audit: services.audit,
    ...config.pipelines,
    hostPort: config.port,
    onChange: (run) => {
      services.operationsEvents?.pipeline(run);
      services.inbox?.changed();
      pipelineRunChanged(services.live, pipelineQueue, run);
      // An agent's coding action shows its run (live-topics.js).
      agentRunChanged(services, run.id);
      const before = pipelineRunCounts.observe(run);
      pipelineListsChanged(services.live, before, run, pipelineRunCounts.listed(run.id));
      // A run that finished or parked may free a slot of its project's queue.
      pipelineQueue?.changed();
    },
  });
  let pipelineQueue;
  try {
    // The one full scan; every later save and delete updates the counts.
    pipelineRunCounts.rebuild(pipelines.store.all());
    await pipelines.recover();
    pipelineQueue = new RunQueue({
      dataDir: config.dataDir,
      engine: pipelines,
      definitions: pipelineDefinitions,
      projects: (id) => services.memory.project(id),
      projectMoved: (id) => services.memory.reboundTo(id),
      audit: services.audit,
      onChange: (projectId) => pipelineQueueChanged(services.live, projectId),
      onError: (error) =>
        console.error(
          `AgentPier could not start a queued pipeline run: ${error?.code || error?.message || "unknown error"}`,
        ),
    });
    await pipelineQueue.recover();
    signalDeletes(pipelines, services, pipelineQueue, pipelineRunCounts);
  } catch (error) {
    await pipelineQueue?.close();
    await pipelines.close();
    throw error;
  }
  return {
    pipelineDefinitions,
    pipelineDriver,
    pipelineWorkspace,
    pipelines,
    pipelineQueue,
    pipelineRunCounts,
  };
}

// A deleted run leaves the store without a save: its topic, the queue item that
// started it, the counts and the lists that showed it still learn it.
function signalDeletes(engine, services, queue, counts) {
  const hub = () => services.live;
  const remove = engine.delete;
  engine.delete = async function (id, ...rest) {
    await remove.call(this, id, ...rest);
    pipelineRunChanged(hub(), queue, { id });
    agentRunChanged(services, id);
    pipelineListsChanged(hub(), counts.forget(id), null);
  };
}
