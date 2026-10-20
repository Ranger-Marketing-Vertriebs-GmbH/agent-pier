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
 * Decides, after the session check, whether a principal may open a socket. A user
 * opens an agent chat she owns, a browser view she may watch, and dictation (which uses
 * the owner's speech connection); every other refusal looks like an unknown path. The
 * owner passes; Task 20's privacy guard narrows his agent chats and browser views.
 */
export function admitSocket(services, principal, { kind, id } = {}) {
  if (principal?.role === "owner") return;
  if (principal?.role !== "user") throw refused();
  if (kind === "dictation") return;
  const scope = services.userScope;
  if (kind === "agent-chat" && scope?.conversationOf(principal, id)) return;
  if (kind === "browser" && scope?.mayWatchBrowser(principal, id) === true) return;
  throw refused();
}
