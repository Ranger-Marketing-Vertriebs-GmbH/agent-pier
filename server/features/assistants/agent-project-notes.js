import { serverCatalogs } from "../../lib/i18n/catalogs.js";
import { pairedTelegram } from "./team-coding.js";
import { lineHiddenCharacterSource } from "./agent-ssh-text.js";

const hidden = new RegExp(lineHiddenCharacterSource, "gu");

/** The messages of the channel's language (German when it has none). */
export const projectMessages = (channel) =>
  (serverCatalogs[channel?.language] || serverCatalogs.de).agentProjects;

// A name or path on one visible line: invisible and control characters (a line
// break among them) show as their code point, so a crafted name cannot fake lines.
const visibleLine = (text) =>
  String(text ?? "").replace(
    hidden,
    (c) => `\\u{${c.codePointAt(0).toString(16).toUpperCase()}}`,
  );

// A name or path the agent chose, as inline code: inside it the Telegram Markdown
// renderer escapes everything (**, __, links), and a backtick, which would end it,
// becomes a look-alike.
const literal = (text) => `\`${visibleLine(text).replaceAll("`", "\u02cb")}\``;

/**
 * The chat notes of an agent's project change (actionNotes): the creation of a project
 * or the agent's switch of its coding sessions, once the action row is settled.
 */
export function projectNotes(a) {
  if (!a.chatNotes?.result) return [];
  const p = a.payload;
  return [
    {
      id: `agent-project:${a.id}`,
      role: "event",
      event: "agent-project",
      change: p.change,
      projectName: p.projectName,
      path: p.path,
      coding: p.coding,
      timestamp: a.chatNotes.result.at,
      runId: null,
    },
  ];
}

/**
 * Tells the owner in the agent's paired Telegram chat what the settled `action` row
 * changed, whatever the turn's origin. A failure is logged and never fails the call.
 */
export function notifyAgentProject(w, agent, action) {
  try {
    const channels = w.s.assistantChannels;
    const target = channels && pairedTelegram(w, agent.id);
    if (!target) return;
    const p = action.payload,
      m = projectMessages(channels.store.get(target.channelId)).telegram,
      who = visibleLine(agent.name),
      name = literal(p.projectName);
    channels.outbox.enqueue({
      key: `agent-project:${action.id}`,
      source: target,
      kind: "agent-project",
      localized: true,
      text:
        p.change === "create"
          ? (p.coding ? m.createdWithCoding : m.created)(who, name, literal(p.path))
          : (p.coding ? m.codingOn : m.codingOff)(who, name),
      path: `/projects/${encodeURIComponent(p.projectId)}?tab=agents`,
    });
  } catch (error) {
    console.error("Agent project notice failed:", error?.message);
  }
}
