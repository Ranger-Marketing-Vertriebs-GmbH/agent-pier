import { PipelineDefinitions } from "../features/pipelines/pipeline-definitions.js";
import { PipelineEngine } from "../features/pipelines/pipeline-engine.js";
import { NativePipelineDriver } from "../features/pipelines/native-driver.js";
import { PipelineWorkspace } from "../features/pipelines/workspace-manager.js";

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
    onChange: (run) => services.operationsEvents?.pipeline(run),
  });
  try {
    await pipelines.recover();
  } catch (error) {
    await pipelines.close();
    throw error;
  }
  return { pipelineDefinitions, pipelineDriver, pipelineWorkspace, pipelines };
}
