import { sshReminder } from "./ssh-hook.js";

export default async function AgentPierSsh() {
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      // Built per turn, so the secrets hint follows its file (secrets-hint.js).
      const reminder = sshReminder("agentpier_ssh_");
      if (Array.isArray(output?.system) && !output.system.includes(reminder))
        output.system.push(reminder);
    },
  };
}
