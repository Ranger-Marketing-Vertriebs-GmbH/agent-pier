import { problem } from "../lib/storage.js";
import { serverMessages } from "../lib/i18n/de.js";

/**
 * Every WebSocket path the server accepts, one per kind. Each attacher matches its
 * upgrades with its pattern here, and the terminal attacher, which refuses every other
 * /api upgrade, skips them all. The first capture group is the target id.
 */
export const terminalPath = /^\/api\/sessions\/([a-zA-Z0-9-]+)\/terminal$/;
export const chatPath = /^\/api\/sessions\/([a-zA-Z0-9_-]+)\/chat-stream$/;
export const agentChatPath = /^\/api\/assistant-conversations\/([^/]+)\/stream$/;
export const browserPath = /^\/api\/assistants\/([A-Za-z0-9_-]+)\/browser-stream$/;
export const dictationPath = /^\/api\/dictation\/stream$/;

export const socketPaths = [
  { kind: "terminal", pattern: terminalPath },
  { kind: "chat", pattern: chatPath },
  { kind: "agent-chat", pattern: agentChatPath },
  { kind: "browser", pattern: browserPath },
  { kind: "dictation", pattern: dictationPath },
];

/** Whether another attacher than the terminal one handles this upgrade path. */
export const ownSocketPath = (pathname) =>
  socketPaths.some(({ kind, pattern }) => kind !== "terminal" && pattern.test(pathname));

const refused = () => problem(serverMessages.http.notFound, 404);

/**
 * The owner's agent chats and browser views under his privacy guard (owner-privacy.js):
 * a user's chat only under her opt-in, then from `since`; a user's own agent's browser
 * only under her opt-in. A target that does not exist passes to the attacher's own 404.
 */
function admitOwner(services, { kind, id }) {
  const privacy = services.ownerPrivacy;
  const store = services.assistants?.store;
  if (!privacy || !store) return {};
  if (kind === "agent-chat") {
    let conversation;
    try {
      conversation = store.getConversation(id);
    } catch {
      return {};
    }
    const { readable, since } = privacy.conversation(conversation);
    if (!readable) throw refused();
    return { since };
  }
  if (kind === "browser") {
    const agent = store.listAssistants().find((a) => a.id === id);
    if (agent && !privacy.agentContent(agent)) throw refused();
    if (agent && services.userScope?.ownerMayWatchBrowser?.(agent) === false)
      throw refused();
    // A user's own agent is hers: under her opt-in the owner watches, never drives.
    if (agent?.userAccess?.mode === "own") return { viewOnly: true };
  }
  return {};
}

/**
 * Decides, after the session check, whether a principal may open a socket, and with
 * what limits (`since` for an agent chat the owner reads under a user's opt-in). A
 * user opens an agent chat she owns, a browser view she may watch, and dictation
 * (which uses the owner's speech connection); every other refusal looks like an
 * unknown path.
 */
export function admitSocket(services, principal, { kind, id } = {}) {
  if (principal?.role === "owner") return admitOwner(services, { kind, id });
  if (principal?.role !== "user") throw refused();
  if (kind === "dictation") return {};
  const scope = services.userScope;
  if (kind === "agent-chat" && scope?.conversationOf(principal, id)) return {};
  if (kind === "browser" && scope?.mayWatchBrowser(principal, id) === true) return {};
  throw refused();
}
