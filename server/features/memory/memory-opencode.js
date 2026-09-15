import { memoryReminder } from "./memory-hook.js";

export default async function AgentPierMemory() {
  const reminder = memoryReminder("agentpier_memory_memory_search");
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      if (Array.isArray(output?.system) && !output.system.includes(reminder))
        output.system.push(reminder);
    },
  };
}
