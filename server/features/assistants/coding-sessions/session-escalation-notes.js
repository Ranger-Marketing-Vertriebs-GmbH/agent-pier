import { serverCatalogs } from "../../../lib/i18n/catalogs.js";
import { redactSecrets } from "../../../lib/secret-redaction.js";
import { actionPath, fenced } from "../action-text.js";

const promptLimit = 1500;
const labelLimit = 64;

/** The channel's coding-session copy (Telegram texts AgentPier writes). */
export const sessionMessages = (channel) =>
  (serverCatalogs[channel?.language] || serverCatalogs.de).agentCodingSessions;

// Cut by code point, so a surrogate pair is never split.
function cut(text, limit) {
  const points = Array.from(text);
  return points.length > limit ? `${points.slice(0, limit).join("")}…` : text;
}

// A name as inline code: the Markdown renderer escapes it and makes no links.
const literal = (text) =>
  `\`${String(text)
    .replaceAll("`", "ˋ")
    .replace(/[\r\n]+/g, " ")}\``;

/** The one question a reply or a button can answer: single, not secret. */
export function singleQuestion(entry) {
  const [q, ...rest] = entry?.kind === "question" ? entry.questions || [] : [];
  return q && !rest.length && !q.secret ? q : null;
}

/** Whether a reply's text may answer the prompt (one question taking free text). */
export const takesText = (entry) => singleQuestion(entry)?.allowOther === true;

// What the prompt asks: each question, or the permission's subject; never secrets.
function promptText(entry, title) {
  if (!entry) return redactSecrets(title || "");
  const s = entry.subject || {};
  const parts =
    entry.kind === "question"
      ? (entry.questions || []).map((q) =>
          [q.header, q.prompt].filter((x) => typeof x === "string" && x).join("\n"),
        )
      : [s.description || s.tool || s.name, s.command || s.path, s.plan];
  return redactSecrets(parts.filter((x) => typeof x === "string" && x).join("\n\n"));
}

// The buttons of a live prompt: one per permission option, or per option of one
// single-choice question; none otherwise.
function buttons(action, entry) {
  const button = (answer, label) => ({
    proposalId: action.id,
    revision: action.revision,
    decision: "answer",
    answer,
    label: cut(String(label), labelLimit),
    // As the escalation itself: valid while the prompt waits.
    expiresAt: null,
  });
  if (entry?.kind === "permission")
    return (entry.options || []).map((o) => button({ choice: o.id }, o.label));
  const q = singleQuestion(entry);
  if (!q || q.multiple) return [];
  return (q.options || []).map((o) => button({ answers: { [q.id]: [o.id] } }, o.label));
}

/**
 * The Telegram message of an escalated session prompt (session-escalations.js):
 * while it waits, the agent, the session, what the prompt asks (at most 1500 code
 * points) and the agent's note, with buttons where one tap answers it, a reply hint
 * for a single free-text question, else a pointer to AgentPier; once answered, who
 * answered it. `entry` is the live prompt (approval only).
 */
export function notifyEscalation(w, action, phase, key, _m, target, entry = null) {
  if (!["approval", "result"].includes(phase)) return;
  const p = action.payload,
    c = sessionMessages(w.s.assistantChannels.store.get(target.channelId));
  let agent = action.assistantId;
  try {
    agent = w.a.store.getAssistant(action.assistantId).name;
  } catch {}
  const heading = c.escalationTelegram(
    agent,
    literal(redactSecrets(p.sessionName || p.sessionId)),
  );
  const asked = cut(promptText(entry, p.title), promptLimit);
  const actions = phase === "approval" ? buttons(action, entry) : [];
  const hint = takesText(entry)
    ? c.escalationReplyHint
    : actions.length
      ? null
      : c.escalationAnswerInApp;
  const answeredBy = action.result?.answeredBy;
  const text =
    phase === "approval"
      ? [
          heading,
          ...(asked ? [fenced(asked)] : []),
          ...(p.note ? [`${c.escalationNote}\n${fenced(redactSecrets(p.note))}`] : []),
          ...(hint ? [hint] : []),
        ].join("\n\n")
      : [
          c.escalationAnsweredBy[answeredBy] || c.escalationAnsweredBy.session,
          heading,
          ...(p.title ? [fenced(cut(redactSecrets(p.title), promptLimit))] : []),
        ].join("\n\n");
  w.s.assistantChannels.outbox.enqueue({
    key,
    source: { ...target, actionId: action.id, escalation: true },
    kind: `action-${phase}`,
    localized: true,
    text,
    path: actionPath(action),
    actions,
  });
}
