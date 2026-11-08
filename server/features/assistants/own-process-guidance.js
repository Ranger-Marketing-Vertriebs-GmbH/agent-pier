import { mayCreateProjects, mayOpenPreviews } from "./goal-turns.js";

/**
 * What the apply of an agent on its own process set (Hermes, AssistantConfig
 * applyOwnProcess) reads beside its record, as the OpenClaw apply does: its SSH grant
 * and the folders its shell PATH starts with (its GitHub folder, its SSH agent's bin/),
 * and the instructions' guidance on what its tools reach (assistant-bootstrap.js):
 * project folders, GitHub, plain ssh aliases, its secrets file, coding sessions,
 * email accounts, project creation and previews. AgentPier's own tools reach a Hermes
 * agent through the team plugin and its bridge (`tools`: the bridge runs), so
 * without it none of that guidance is given. Memory is Hermes's own memory tool
 * (`memoryKind` "hermes"), never AgentPier's memory files; image creation is, while its images reach the chat through the team plugin
 * (`images`: a ChatGPT login AgentPier holds serves them, hermes-config/images.js).
 * Never fails the apply.
 */
export async function ownProcessInputs(
  config,
  assistant,
  { tools = false, images = false } = {},
) {
  const senderFacing = !!config.senderFacing?.(assistant);
  const ssh = !!config.sshGranted?.(assistant);
  const shellPath = [
    ...(config.githubShellPath?.(assistant) || []),
    ...(config.sshShellPath?.(assistant) || []),
  ];
  const plainSsh = tools
    ? await Promise.resolve()
        .then(() => config.plainSsh?.(assistant))
        .catch(() => null)
    : null;
  const guidance = {
    memoryKind: "hermes",
    projectFolders: (tools && config.projectFolders?.(assistant)) || [],
    github: (tools && config.github?.(assistant)) || null,
    plainSsh: plainSsh || null,
    // Hermes's image_generate waits for its image (no background task).
    images: tools && images ? "inline" : false,
    secrets: !!config.secretsGranted?.(assistant),
    codingSessions: (tools && config.codingSessions?.(assistant)) || [],
    mailAccounts: (tools && config.mailAccounts?.(assistant)) || [],
    projectCreation: tools && mayCreateProjects(assistant, senderFacing),
    previews: tools && mayOpenPreviews(assistant, senderFacing),
  };
  return { ssh, shellPath, guidance };
}
