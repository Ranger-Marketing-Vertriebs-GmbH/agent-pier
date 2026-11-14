import { craftAvailable } from "../features/craft/agent-craft.js";
import { talkAgent } from "../features/assistants/session-talk/talk-reach.js";

/**
 * The configuration inputs AssistantWorkflows answers for an agent's instructions
 * and shell: its SSH grant, project folders, GitHub access, coding-session projects
 * and email accounts, and whether Craft Anything rebuilds are available.
 */
export function workflowInstructionWiring(workflows) {
  return {
    // Agents with an SSH grant get agentpier_ssh (assistant-access.js).
    sshGranted: (assistant) => workflows.access.hasSshGrants(assistant.id),
    // Project folders the agent may use directly, named in its instructions.
    projectFolders: (assistant) => workflows.folders.forAgent(assistant),
    // Its GitHub access, named in its instructions, and its shell's GitHub folder.
    github: (assistant) => workflows.github.describe(assistant),
    githubShellPath: (assistant) => workflows.github.shellPath(assistant),
    // Projects it may start coding sessions on, named in its instructions.
    codingSessions: (assistant) => workflows.sessions.projects(assistant.id),
    // Projects whose coding sessions may talk to it, within its granted projects.
    talkProjectIds: (assistant) => {
      try {
        if (!talkAgent(workflows, assistant.id)) return [];
        const policy = workflows.access.get(assistant.id);
        return (policy.talkProjectIds || []).filter((id) =>
          policy.projectIds.includes(id),
        );
      } catch {
        return [];
      }
    },
    // Its granted email accounts, named in its instructions (names and ids only).
    mailAccounts: (assistant) =>
      workflows.mail
        .accounts(assistant.id)
        .map(({ accountId, name }) => ({ accountId, name })),
    // agentpier_craft (craft/agent-craft.js), read late: the supervisor is made after
    // the assistants (services.js).
    craftAvailable: () => craftAvailable(workflows.s),
  };
}
