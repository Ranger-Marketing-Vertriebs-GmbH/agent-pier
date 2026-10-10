import { sweepAssistantStorage } from "../features/assistants/runtime-retention.js";

/**
 * Runs once after the assistant graph is connected, before AgentPier listens: starts
 * advancing workflow actions, sweeps abandoned installation stages and recovers an
 * interrupted runtime update, entering maintenance when that recovery fails.
 */
export async function recoverAssistantServices(services) {
  services.assistantWorkflows.start();
  await sweepAssistantStorage(services.assistantRuntime.paths).catch(() => {});
  try {
    await services.assistantUpdates.recover();
  } catch {
    services.assistants.maintenance = true;
  }
}
