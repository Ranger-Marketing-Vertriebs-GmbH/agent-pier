import { mayCreateProjects, mayOpenPreviews } from "./goal-turns.js";
import { recallsChats } from "./native-capabilities.js";
import { memoryFor, traitOf } from "./runtimes/runtime-for.js";
import { resolveOptionConnections } from "./option-connections.js";

/**
 * The instructions' guidance (assistant-bootstrap.js) of an agent on the shared
 * Gateway (OpenClaw, AssistantConfig applyOnce) on what its tools reach now.
 * `nativeReady`: AgentPier's native tools are offered; `senderFacing`: the Gateway
 * serves its own bot for other people; `craft`: rebuilds are available; `plainSsh`:
 * its SSH agent as synced for this turn; `images`: this start can serve the image
 * tool (web-tools.js availability).
 */
export function gatewayGuidance(
  config,
  assistant,
  { nativeReady, senderFacing, craft, plainSsh, images },
) {
  const guard = !!config.writeGuard?.();
  return {
    memoryWritable: guard,
    // Whether it holds the tools that read its earlier chats (recallTools).
    recall: nativeReady && recallsChats(assistant) && !senderFacing,
    // Its granted project folders, resolved now (agent-project-files.js).
    projectFolders: (nativeReady && config.projectFolders?.(assistant)) || [],
    // Its GitHub access: profile, level and the server's tool prefix.
    github: (nativeReady && config.github?.(assistant)) || null,
    // Its trusted hosts' plain ssh aliases, by catalog name (agent-ssh-shell.js).
    plainSsh: plainSsh || null,
    images: nativeReady && images && guard,
    // Whether it receives a secrets file; names the file, never its contents.
    secrets: !!config.secretsGranted?.(assistant),
    // The projects it may start coding sessions on (AgentCodingSessions.projects).
    codingSessions: (nativeReady && config.codingSessions?.(assistant)) || [],
    // The projects whose coding sessions may talk to it (talk-reach.js).
    talkProjectIds: (nativeReady && config.talkProjectIds?.(assistant)) || [],
    // Its granted email accounts (AgentMail.accounts), by name and id only.
    mailAccounts: (nativeReady && config.mailAccounts?.(assistant)) || [],
    // Whether it holds agentpier_project (profileTools without senderLockedTools).
    projectCreation: nativeReady && mayCreateProjects(assistant, senderFacing),
    // Whether it holds agentpier_craft as well.
    craft: craft && nativeReady && mayCreateProjects(assistant, senderFacing),
    previews: nativeReady && mayOpenPreviews(assistant, senderFacing),
  };
}

/**
 * What the apply of an agent on its own process set (Hermes, AssistantConfig
 * applyOwnProcess) reads beside its record, as the OpenClaw apply does: its SSH grant
 * and the folders its shell PATH starts with (its GitHub folder, its SSH agent's bin/),
 * and the instructions' guidance on what its tools reach (assistant-bootstrap.js):
 * project folders, GitHub, plain ssh aliases, its secrets file, coding sessions,
 * email accounts, project creation, rebuilds (`craft`) and previews. AgentPier's own
 * tools reach a Hermes agent through the team plugin and its bridge (`tools`: the
 * bridge runs), so without it none of that guidance is given. Memory is as its
 * runtime keeps it (`memoryFormat`, the trait agentFiles.memoryFormat, with the
 * format's `pinMarker`): Hermes's own memory tool, never AgentPier's memory files;
 * image creation is, while its images reach the chat through the team plugin
 * (`images`: a ChatGPT login AgentPier holds serves them, hermes-config/images.js).
 * `optionConnections`: the model connections its runtime options name, resolved
 * (option-connections.js). Never fails the apply.
 */
export async function ownProcessInputs(
  config,
  assistant,
  { tools = false, images = false } = {},
) {
  const senderFacing = !!config.senderFacing?.(assistant);
  const ssh = !!config.sshGranted?.(assistant);
  const craft = !!config.craftAvailable?.();
  const devices = !!config.devicesAvailable?.();
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
    memoryFormat: traitOf(assistant, "agentFiles", "memoryFormat"),
    pinMarker: memoryFor(assistant).pinMarker,
    projectFolders: (tools && config.projectFolders?.(assistant)) || [],
    github: (tools && config.github?.(assistant)) || null,
    plainSsh: plainSsh || null,
    // Hermes's image_generate waits for its image (no background task).
    images: tools && images ? "inline" : false,
    secrets: !!config.secretsGranted?.(assistant),
    codingSessions: (tools && config.codingSessions?.(assistant)) || [],
    talkProjectIds: (tools && config.talkProjectIds?.(assistant)) || [],
    mailAccounts: (tools && config.mailAccounts?.(assistant)) || [],
    projectCreation: tools && mayCreateProjects(assistant, senderFacing),
    craft: tools && craft && mayCreateProjects(assistant, senderFacing),
    previews: tools && mayOpenPreviews(assistant, senderFacing),
  };
  const optionConnections = await resolveOptionConnections(config.models, assistant);
  return { ssh, craft, devices, shellPath, guidance, optionConnections };
}
