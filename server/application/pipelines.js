import { PipelineDefinitions } from "../features/pipelines/pipeline-definitions.js";
import { PipelineEngine } from "../features/pipelines/pipeline-engine.js";
import { NativePipelineDriver } from "../features/pipelines/native-driver.js";
import { PipelineWorkspace } from "../features/pipelines/workspace-manager.js";
import { RunQueue } from "../features/pipelines/run-queue.js";

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
      // A run that finished or parked may free a slot of its project's queue.
      pipelineQueue?.changed();
    },
  });
  let pipelineQueue;
  try {
    await pipelines.recover();
    pipelineQueue = new RunQueue({
      dataDir: config.dataDir,
      engine: pipelines,
      definitions: pipelineDefinitions,
      projects: (id) => services.memory.project(id),
      audit: services.audit,
      onError: (error) =>
        console.error(
          `AgentPier could not start a queued pipeline run: ${error?.code || error?.message || "unknown error"}`,
        ),
    });
    await pipelineQueue.recover();
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
  };
}
