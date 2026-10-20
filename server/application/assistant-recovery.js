import { sweepAssistantStorage } from "../features/assistants/runtime-retention.js";
import { UserAgents } from "../features/users/user-agents.js";

/**
 * Runs once after the assistant graph is connected, before AgentPier listens: starts
 * advancing workflow actions, sweeps abandoned installation stages, ends what users
 * disabled while agents were off left running and recovers an interrupted runtime
 * update, entering maintenance when that recovery fails.
 */
export async function recoverAssistantServices(services) {
  services.assistantWorkflows.start();
  await sweepAssistantStorage(services.assistantRuntime.paths).catch(() => {});
  await endDisabledUsers(services);
  try {
    await services.assistantUpdates.recover();
  } catch {
    services.assistants.maintenance = true;
  }
}

// A user disabled while agents were off: her reminders, routines, check-ins and bots
// end now, before any of them runs again. Their native jobs go at the Gateway start.
async function endDisabledUsers(services) {
  const agents = new UserAgents(services);
  for (const user of services.users?.list() || [])
    if (user.disabled) await agents.disableUser(user.id).catch(() => {});
}
