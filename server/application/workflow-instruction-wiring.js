/**
 * The configuration inputs AssistantWorkflows answers for an agent's instructions
 * and shell: its SSH grant, project folders, GitHub access and coding-session projects.
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
  };
}
