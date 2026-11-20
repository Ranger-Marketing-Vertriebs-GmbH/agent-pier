// ⌘K entries for a session's own actions (AGENTPIER-418): "<session> · Reload & resume",
// "· Continue with another account", "· AgentPier tools", "· Stop session" or "· Remove
// session" and "· Background tasks". Each opens the session and requests its page
// action `session-<action>:<id>` (useSessionActions.jsx, ChatView.jsx), so only that
// session's view takes it; Stop and Remove still ask first.
import { backgroundTasksCopy } from "../../lib/i18n/messages/chat.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { mcpCopy } from "../../lib/i18n/messages/mcp.js";
import { sessionReloadCopy } from "../../lib/i18n/messages/sessions.js";
import { cliDefinition, isCodingCli } from "../../../server/features/clis/catalog.js";
import { bilingual, join, same } from "../../app/search-labels.js";

/** Whether a session can reload and resume (as SessionWorkspace decides). */
export const sessionReloadable = (session) =>
  session.tool !== "shell" && !session.pipeline && session.purpose !== "login";

/** Whether a reloadable session can continue with another account of its CLI. */
export const sessionSwitchable = (session) =>
  sessionReloadable(session) &&
  isCodingCli(session.tool) &&
  Boolean(cliDefinition(session.tool).capabilities.accountTransfer) &&
  !session.provider &&
  !session.access?.providerConnectionId;

const running = (session) => session.status === "running";

// [action, label, applies(session), icon, mode]: `mode` opens the session in that tab.
const sessionActions = [
  ["reload", () => sessionReloadCopy.title, sessionReloadable, "refresh"],
  ["switch-account", () => sessionReloadCopy.switchTitle, sessionSwitchable, "users"],
  [
    "mcp",
    () => mcpCopy.sessionTools,
    (session) => Boolean(session.agentpierTools),
    "shield",
  ],
  [
    "stop",
    () => commonCopy.stopSession,
    (session) => running(session) && !session.pipeline?.headless,
    "stop",
  ],
  ["remove", () => commonCopy.removeSession, (session) => !running(session), "trash"],
  [
    "tasks",
    () => backgroundTasksCopy.title,
    (session) => session.tool !== "shell" && session.purpose !== "login",
    "terminal",
    "reader",
  ],
];

const folder = (cwd) => (cwd ? cwd.split("/").filter(Boolean).at(-1) || cwd : "");

/** The action entries of every session the sidebar lists. */
export function sessionActionEntries({ sessions = [] } = {}) {
  const root = bilingual(() => commonCopy.sessions);
  const entries = [];
  for (const session of sessions) {
    if (!session?.id || !session.name) continue;
    if (session.pipeline?.headless && session.status === "stopped") continue;
    const project = session.repositoryName || folder(session.cwd);
    for (const [id, label, applies, icon, mode] of sessionActions) {
      if (!applies(session)) continue;
      const own = bilingual(label);
      entries.push({
        id: `session:${session.id}:${id}`,
        group: "actions",
        label: { de: `${session.name} · ${own.de}`, en: `${session.name} · ${own.en}` },
        path: project ? join(root, same(project)) : root,
        target: {
          session: session.id,
          ...(mode ? { mode } : {}),
          pending: `session-${id}:${session.id}`,
        },
        aliases: [],
        icon,
        extra: [project, session.tool].filter(Boolean),
      });
    }
  }
  return entries;
}
