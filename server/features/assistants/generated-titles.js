import { firstWrittenTurn, generatedTitle } from "./chat-titles.js";
import {
  chatTitleMethod,
  titleSourceLimit,
  titleTimeoutMs,
} from "./team-plugin/chat-title.js";

// A chat's generated title (AGENTPIER-187). Once the chat's first written turn has
// its reply, the agent's own model names the chat in 3 to 6 words from that message
// and the reply's start (team-plugin/chat-title.js): a prompt with no tools, session,
// memory or workspace, so it is no turn and shows nowhere in the chat. Until then,
// and whenever it fails, the chat keeps its first-message title (chat-titles.js).

const clip = (text) => [...text].slice(0, titleSourceLimit).join("").trim();

/** The text of the run's reply in the chat's cached history, or "". */
function replyText(service, conversationId, runIds) {
  return service.store
    .messages(conversationId)
    .filter((m) => m.role === "assistant" && runIds.includes(m.runId))
    .map((m) => m.text)
    .join("\n");
}

/**
 * Called when a turn's attempt completed (run-reconciler.js). Only the chat's first
 * written turn (owner, user, Telegram; not forwarded) with a reply, in a chat still
 * named automatically, asks for a title, once; a rename made meanwhile wins. Never
 * throws.
 */
export async function titleAfterReply(service, conversation, request, attempt) {
  const id = conversation.id;
  const titling = (service.titling ??= new Set());
  if (titling.has(id)) return;
  let current;
  try {
    current = service.store.storedConversation(id);
  } catch {
    return;
  }
  if (
    current.titleSource !== "auto" ||
    current.generatedTitle ||
    current.deletedAt ||
    current.userReleased
  )
    return;
  const first = firstWrittenTurn(service, id);
  if (first?.request.id !== request.id) return;
  // A forwarded Telegram message is not her writing (message-source.js).
  if (service.teams?.store.context(request.id)?.forwarded) return;
  const reply = clip(
    replyText(service, id, [attempt.runtimeRunId, attempt.id].filter(Boolean)),
  );
  const message = clip(first.text);
  if (!reply || !message) return;
  const client = service.runtime.client;
  if (!client?.ready) return;
  titling.add(id);
  let title = null,
    problem = "EMPTY";
  try {
    const agent = service.store.getAssistant(conversation.assistantId);
    const result = await client.call(
      chatTitleMethod,
      { agentId: agent.runtimeAgentId, message, reply },
      { timeoutMs: titleTimeoutMs + 5000 },
    );
    title = generatedTitle(result?.title);
  } catch (error) {
    problem = typeof error?.code === "string" ? error.code : "FAILED";
  } finally {
    titling.delete(id);
  }
  if (!title) {
    // Only a code: never the texts or what the model said.
    console.warn(`Agent chat ${id} kept its first-message title (${problem}).`);
    return;
  }
  let latest;
  try {
    latest = service.store.storedConversation(id);
  } catch {
    return;
  }
  // Renamed, deleted or released while the model answered: that stays.
  if (
    latest.titleSource !== "auto" ||
    latest.title !== current.title ||
    latest.deletedAt ||
    latest.userReleased
  )
    return;
  service.store.updateConversation(id, {
    title,
    titleSource: "generated",
    generatedTitle: title,
  });
  service.changed({ conversationId: id });
}
