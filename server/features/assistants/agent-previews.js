import { serverCatalogs } from "../../lib/i18n/catalogs.js";
import { previewError } from "../previews/preview-errors.js";
import { exact } from "./assistant-access.js";
import { assistantProblem } from "./assistant-validation.js";
import { literal, visibleLine } from "./agent-project-notes.js";
import { followUpTelegram } from "./follow-up-target.js";
import { mayOpenPreviews } from "./goal-turns.js";
import { ownerChatCall } from "./owner-runs.js";

/** What the tool result tells the agent to do with the link. */
export const previewNote =
  "Give the owner this link; it opens the server through AgentPier.";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const loopback = (url) => {
  try {
    return loopbackHosts.has(new URL(url).hostname);
  } catch {
    return true;
  }
};
// The link as Markdown for the Telegram renderer: characters it reads as markup
// (an agent chooses the path) are percent-encoded, so the link stays one link.
const markdownLink = (url) => {
  const safe = url.replace(
    /[()[\]*_~`\\<>|!"]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
  return `[${safe}](${safe})`;
};

/**
 * The owner's chat behind an agentpier_preview call (owner-runs.js ownerChatCall):
 * a turn of their own chat with their own agent or permanent member that is not
 * someone else's content, or a run of that chat without a turn. Never a routine's or
 * a hook's run, a restricted user's chat, a user agent or an agent with its own bot
 * for other people. Throws FORBIDDEN otherwise.
 */
function previewTurn(w, inv) {
  const turn = ownerChatCall(w.a, inv);
  const senderFacing = !!turn && !!w.s.assistantTelegramSenders?.connected(turn.agent.id);
  if (!turn || !mayOpenPreviews(turn.agent, senderFacing))
    throw assistantProblem("invalid", 403);
  return turn;
}

// The owner's paired Telegram chat the call's turn came from (agent-shares.js
// target), or for a run without a turn the chat its latest turn came from.
function telegramTarget(w, { agent, conversation, origin, request }) {
  try {
    if (!request)
      return followUpTelegram(w.a, w.s.assistantChannels, agent, conversation);
    return w.a.shares?.target(origin) ?? null;
  } catch {
    return null;
  }
}

/**
 * Sends the preview's link to the owner's Telegram chat the turn came from. A link to
 * 127.0.0.1 opens nothing on their phone and is not sent. A failure is logged and
 * never fails the call.
 */
export function notifyAgentPreview(w, agent, target, preview) {
  try {
    const channels = w.s.assistantChannels;
    if (!target || !channels || loopback(preview.url)) return;
    const channel = channels.store.get(target.channelId);
    const m = (serverCatalogs[channel?.language] || serverCatalogs.de).previews;
    channels.outbox.enqueue({
      key: `agent-preview:${preview.id}`,
      source: target,
      kind: "agent-preview",
      localized: true,
      text: m.telegram.opened(
        visibleLine(agent.name),
        literal(preview.label),
        markdownLink(preview.url),
      ),
    });
  } catch (error) {
    console.error("Agent preview notice failed:", error?.message);
  }
}

const view = (previews, preview) => ({
  id: preview.id,
  url: previews.previewUrl(preview),
  port: preview.target,
  label: preview.label,
});

/**
 * agentpier_preview: the agent opens, closes and lists previews of servers it runs,
 * owned by the calling chat (PreviewService, owner `kind: "agent"`). Preview problems
 * reach the agent as their PREVIEW_* code (tool-errors.js).
 */
export async function invokePreview(w, inv, input) {
  inv.assertCurrent();
  const turn = previewTurn(w, inv);
  const previews = w.s.previews;
  if (!previews) throw previewError("PREVIEW_UNAVAILABLE", 503);
  const conversationId = turn.conversation.id;
  const mine = () => previews.list({ conversationId });
  if (input?.action === "list") {
    exact(input, ["action"]);
    return { items: mine().map((preview) => view(previews, preview)) };
  }
  if (input?.action === "close") {
    exact(input, ["action", "id", "port"]);
    const { id, port } = input;
    if (
      (id === undefined) === (port === undefined) ||
      (id !== undefined && typeof id !== "string") ||
      (port !== undefined && !Number.isInteger(port))
    )
      throw assistantProblem("invalid");
    const found = mine().find((preview) =>
      id === undefined ? preview.target === port : preview.id === id,
    );
    if (!found) throw previewError("PREVIEW_NOT_FOUND", 404);
    return previews.close(found.id, { reason: "tool", source: "agent" });
  }
  if (input?.action === "open") {
    exact(input, ["action", "port", "label", "path"]);
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
      throw assistantProblem("invalid");
    const { agent } = turn;
    const opened = await previews.open({
      owner: { kind: "agent", assistantId: agent.id, conversationId, project: agent.id },
      port: input.port,
      label: input.label,
      path: input.path,
    });
    notifyAgentPreview(w, agent, telegramTarget(w, turn), opened);
    return { ...opened, note: previewNote };
  }
  throw assistantProblem("invalid");
}
