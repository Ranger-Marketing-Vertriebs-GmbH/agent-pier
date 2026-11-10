import { assistantProblem } from "./assistant-validation.js";
import {
  MAX_CAPTION_LENGTH,
  projectShareTarget,
  readShareSource,
  shareRoots,
} from "./agent-share-source.js";
import { attachmentsAllowed, chatFile } from "./attachment-access.js";
import { chatFolderPath, keepsChatFolders } from "./chat-file-folders.js";
import { routineOrigin } from "./routine-targets.js";
import { followUpTelegram } from "./follow-up-target.js";
import { keepGeneratedImage } from "./hermes-generated-images.js";
import { routineRunOf } from "./runtimes/runtime-for.js";

/**
 * agentpier_share_file: an agent hands the owner a file from its own workspace.
 *
 * The copy joins the chat of the turn that shared it (agent-attachments.js share):
 * the owner's own chat, or a member's chat for a lead's question or task or a team
 * assignment. A member's file also appears in its lead's chat, attributed to the
 * member, since that is where the owner follows the lead's work. When the turn came
 * from the owner's Telegram chat (directly, or through the lead's turn a member works
 * for), the file is queued for that chat as well (telegram-file.js); Telegram never
 * sees a file from any other turn.
 *
 * A routine's run (no attempt; the bridge admits its run session as for SSH) shares
 * into the chat its routine commits to, and to the Telegram chat it delivers to; a
 * hook's run, also after its event settled, into the agent's main chat only.
 *
 * The owner decided that an agent may always send him files (owner-shares.js): any
 * other run of his chat without a turn (OpenClaw's follow-up after a background
 * command, a check-in) shares into that chat, as the chat's latest turn, and to
 * Telegram by the rule of that run's text reply (follow-up-target.js).
 *
 * With `projectId` the file comes from a project folder (AGENTPIER-123) instead of
 * the workspace: read access is enough, and the path is resolved like every folder
 * read (project-paths.js: never .git, never AgentPier's data). For the owner's chat
 * every folder the agent holds now counts, in every turn; a routine or hook run
 * reads what its own rights reach, and a restricted user's turn what that turn may.
 *
 * With `generated` (only the Hermes team plugin's image hook passes it) the file is
 * an image the Hermes agent created, by its name in Hermes's image cache: it is
 * shared like any file and kept in the chat's file folder for the agent
 * (hermes-generated-images.js), whose path the result names as `image`.
 */
/**
 * What the tool result tells the agent about who sees the file now: the owner in his
 * chats, the person who asked in a user's chat (which the owner does not read).
 */
export const shareNotes = {
  owner:
    "The owner sees the file in the chat now; do not repeat its contents unless asked.",
  user: "The person who asked sees the file in this chat now; do not repeat its contents unless asked.",
};
export const shareNote = (conversation) =>
  conversation?.userId ? shareNotes.user : shareNotes.owner;

// On a shared agent a turn reads only its own chat's uploads (attachment-access.js),
// and never OpenClaw's inbound media.
function admitChatFile(assistants, agent, conversation, relative) {
  const file = chatFile(relative);
  if (
    file !== null &&
    !attachmentsAllowed(assistants.store, agent, conversation.id, [file])
  )
    throw assistantProblem("shareNotFound", 404);
}

/**
 * Reads a file the turn may hand on (`input`: `{ path, projectId? }`): from a project
 * folder the turn may read, else from the agent's own workspace or, for a Hermes
 * agent, this chat's file folder by absolute path; on a shared agent only this chat's
 * uploads and never OpenClaw's inbound media. `{ name, body, identity }` within
 * `maxBytes` (agent-share-source.js readShareSource). agentpier_share_file and the
 * pictures of agentpier_craft read through it.
 */
export async function readTurnFile(
  assistants,
  invocation,
  agent,
  conversation,
  input,
  { maxBytes } = {},
) {
  const limit = maxBytes ? { maxBytes } : {};
  if (input.projectId) {
    const { roots, relative, refuseDirs } = projectShareTarget(assistants, agent, input, {
      invocation,
      conversation,
    });
    return readShareSource(roots, relative, { refuseDirs, ...limit });
  }
  const config = assistants.attachments.config;
  const admit = (relative) => admitChatFile(assistants, agent, conversation, relative);
  return readShareSource(
    [
      ...shareRoots(config?.workspaces, agent),
      // A Hermes agent's uploads of this chat, by absolute path.
      ...(keepsChatFolders(agent)
        ? [chatFolderPath(config, agent.id, conversation.id)]
        : []
      ).filter(Boolean),
    ],
    input.path,
    { admit, ...limit },
  );
}

export class AgentShares {
  constructor({ assistants, channels = null }) {
    Object.assign(this, { assistants, channels });
  }
  async invoke(invocation, input) {
    if (
      !input ||
      typeof input !== "object" ||
      Object.keys(input).some(
        (key) => !["path", "caption", "projectId", "generated"].includes(key),
      ) ||
      ("generated" in input
        ? typeof input.generated !== "string" || "path" in input || "projectId" in input
        : typeof input.path !== "string") ||
      ("projectId" in input && typeof input.projectId !== "string") ||
      ("caption" in input &&
        (typeof input.caption !== "string" || input.caption.length > MAX_CAPTION_LENGTH))
    )
      throw assistantProblem("invalid");
    const a = this.assistants;
    // No workspace reads while a restore or update may replace them.
    if (a.closed || a.maintenance || a.recovering)
      throw assistantProblem("unavailable", 503);
    const { conversation, requestId, origin, via, target } = this.turn(invocation);
    const agent = a.store.getAssistant(conversation.assistantId);
    if (agent.archivedAt) throw assistantProblem("invalid", 403);
    const { path: image = null, ...source } = input.generated
      ? await keepGeneratedImage(a, agent, conversation, input.generated)
      : await readTurnFile(a, invocation, agent, conversation, input);
    invocation.assertCurrent();
    const caption = (input.caption || "").trim();
    const file = await a.attachments.share({
      conversation,
      requestId,
      ...source,
      caption,
      mirror: this.leadChat(origin, agent),
    });
    const telegram = this.telegram(origin, file, caption, target);
    const kind = input.generated ? "generated-image" : "share";
    this.audit(agent, origin, telegram, input.projectId, kind, "success", via);
    a.changed?.();
    return {
      status: "shared",
      file: { name: file.name, type: file.type, size: file.size },
      // A Hermes agent's created image: its copy in this chat's file folder.
      ...(image ? { image } : {}),
      ...(telegram ? { telegram } : {}),
      note: shareNote(conversation),
    };
  }
  admit(agent, conversation, relative) {
    admitChatFile(this.assistants, agent, conversation, relative);
  }
  // The chat, request key and trusted origin of the calling turn.
  turn(invocation) {
    const a = this.assistants;
    if (invocation.hook && !invocation.attemptId) {
      const { conversation, event } = invocation.hook;
      return {
        conversation: a.store.getConversation(conversation.id),
        requestId: `hook:${event.id}`,
        origin: { kind: "hook" },
      };
    }
    // A run of the owner's chat without a turn shares as the chat's latest turn, to
    // Telegram like its reply; a hook's settled session only into the main chat.
    if (invocation.owner && !invocation.attemptId) {
      const { conversationId, eventId } = invocation.owner;
      const conversation = a.store.getConversation(conversationId);
      const via = { via: "agent-run" };
      if (eventId)
        return {
          conversation,
          requestId: `hook:${eventId}`,
          origin: { kind: "hook" },
          via,
          target: null,
        };
      const latest = a.ledger.latestRequest(conversation.id);
      const agent = a.store.getAssistant(conversation.assistantId);
      return {
        conversation,
        requestId: latest?.id ?? `run:${invocation.runId || invocation.toolCallId}`,
        origin: (latest && a.teams?.store?.context(latest.id)) || { kind: "unknown" },
        via,
        target: followUpTelegram(a, this.channels, agent, conversation),
      };
    }
    if (invocation.routine && !invocation.attemptId) {
      const { binding, conversation } = invocation.routine;
      // The run session names the run (routines.runOf).
      const run = routineRunOf(null, invocation.sessionKey)?.runId;
      return {
        conversation: a.store.getConversation(conversation.id),
        requestId: `routine:${run || binding.id}`,
        origin: routineOrigin(binding),
      };
    }
    if (!invocation.attemptId) throw assistantProblem("invalid", 403);
    const attempt = a.ledger.getAttempt(invocation.attemptId);
    const request = a.ledger.getRequest(attempt.requestId);
    return {
      conversation: a.store.getConversation(request.conversationId),
      requestId: request.id,
      origin: a.teams?.store?.context(request.id) || { kind: "unknown" },
    };
  }
  // The lead's chat a member's turn works for, or null.
  leadChat(origin, agent) {
    const teams = this.assistants.teams;
    if (!agent.teamMemberId || !teams) return null;
    let conversationId = null;
    try {
      if (origin.kind === "lead-request")
        conversationId = teams.requests?.store.get(origin.requestId).parentConversationId;
      else if (origin.kind === "team-member")
        conversationId = teams.store.find(origin.teamId)?.parentConversationId;
      if (typeof conversationId !== "string") return null;
      this.assistants.store.getConversation(conversationId);
    } catch {
      return null;
    }
    return { conversationId, from: agent.name };
  }
  // The owner's paired Telegram chat the turn came from, while it is still paired.
  target(origin) {
    const own =
      origin.kind === "telegram"
        ? origin
        : origin.telegram && typeof origin.telegram === "object"
          ? origin.telegram
          : null;
    if (!own || !this.channels) return null;
    try {
      const channel = this.channels.store.get(own.channelId);
      if (
        !channel.enabled ||
        channel.chatId !== own.chatId ||
        channel.userId !== own.userId
      )
        return null;
      return { channelId: channel.id, chatId: channel.chatId, userId: channel.userId };
    } catch {
      return null;
    }
  }
  // Queues the file for Telegram (`target`: the turn's, unless given); the chat copy
  // stands even when this fails.
  telegram(origin, file, caption, target = this.target(origin)) {
    if (!target) return null;
    try {
      this.channels.outbox.enqueue({
        key: `share:${file.id}`,
        source: { ...target, attachmentId: file.id },
        kind: "file",
        // Shown in the channel's activity list; Telegram gets only the caption.
        text: caption || file.name,
        caption,
      });
      return "queued";
    } catch {
      return "unavailable";
    }
  }
  // `kind` "generated-image" marks an image the agent created (generated-images.js);
  // `via` marks a share of a run without a turn (`agent-run`).
  audit(
    agent,
    origin,
    telegram,
    projectId,
    kind = "share",
    outcome = "success",
    via = null,
  ) {
    try {
      this.assistants.audit?.append({
        action: "assistant.sent",
        resourceType: "assistant",
        resourceId: agent.id,
        ...(projectId ? { projectId } : {}),
        source: "system",
        outcome,
        details: {
          kind,
          channel: telegram === "queued" ? "telegram" : "tool",
          ...(origin.kind === "lead-request" && origin.leadAssistantId
            ? { leadAssistantId: origin.leadAssistantId }
            : {}),
          ...via,
        },
      });
    } catch {
      /* The share stands; the audit log reports its own failures. */
    }
  }
}
