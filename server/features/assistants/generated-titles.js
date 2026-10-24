import { firstWrittenTurn, generatedTitle, written } from "./chat-titles.js";
import { goalTurn } from "./goal-turns.js";
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

const log = (id, code) =>
  // Only a code: never the texts or what the model said.
  console.warn(`Agent chat ${id} kept its first-message title (${code}).`);
// The plugin's own failure code (LLM_COMPLETION_TIMEOUT, ...) where the Gateway
// answered with one (gateway-client.js remoteCode), else the call's code.
const errorCode = (error) =>
  [error?.remoteCode, error?.code].find(
    (code) => typeof code === "string" && /^[A-Z_]{1,60}$/.test(code),
  ) ?? "FAILED";

/**
 * Called, unawaited, when a turn's attempt completed (run-reconciler.js). Only the
 * chat's first written turn (owner, user, Telegram; not forwarded) with a reply, in a
 * chat still named automatically, asks for a title; a rename made meanwhile wins.
 * Never rejects: a failure keeps the first-message title and is logged as a code.
 */
export async function titleAfterReply(service, conversation, request, attempt) {
  try {
    await nameChat(service, conversation, request, attempt);
  } catch (error) {
    log(conversation.id, errorCode(error));
  }
}

async function nameChat(service, conversation, request, attempt) {
  const id = conversation.id;
  const titling = (service.titling ??= new Set());
  if (titling.has(id)) return;
  const current = service.store.storedConversation(id);
  // One decision per chat (`titleTried`): later turns read nothing more.
  if (
    current.titleSource !== "auto" ||
    current.titleTried ||
    current.generatedTitle ||
    current.deletedAt ||
    current.userReleased
  )
    return;
  // Once the chat's first written turn has had its run, the chance has passed:
  // without a reply, forwarded, or answered, the chat is never asked again (a failure
  // is not retried on later turns).
  // A scheduled or team turn never decides; only written turns read the chat's turns.
  const context = service.teams?.store.context(request.id);
  if (goalTurn(context) || !written.has(context?.kind ?? "owner")) return;
  const tried = () => service.store.updateConversation(id, { titleTried: true });
  const first = firstWrittenTurn(service, id);
  if (!first) return;
  if (first.request.id !== request.id) return tried();
  // A forwarded Telegram message is not her writing (message-source.js).
  if (context?.forwarded) return tried();
  const reply = clip(
    replyText(service, id, [attempt.runtimeRunId, attempt.id].filter(Boolean)),
  );
  const message = clip(first.text);
  if (!reply || !message) return tried();
  const client = service.runtime.client;
  if (!client?.ready) return;
  tried();
  titling.add(id);
  let title;
  try {
    const agent = service.store.getAssistant(conversation.assistantId);
    const result = await client.call(
      chatTitleMethod,
      { agentId: agent.runtimeAgentId, message, reply },
      { timeoutMs: titleTimeoutMs + 5000 },
    );
    title = generatedTitle(result?.title);
  } finally {
    titling.delete(id);
  }
  if (!title) return log(id, "EMPTY");
  const latest = service.store.storedConversation(id);
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
