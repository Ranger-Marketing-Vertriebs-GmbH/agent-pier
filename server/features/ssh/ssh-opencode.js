import { sshReminder } from "./ssh-hook.js";

export default async function AgentPierSsh() {
  const reminder = sshReminder("agentpier_ssh_");
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      if (Array.isArray(output?.system) && !output.system.includes(reminder))
        output.system.push(reminder);
    },
  };
}
