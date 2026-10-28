import addressparser from "nodemailer/lib/addressparser";
import { serverCatalogs } from "../../../lib/i18n/catalogs.js";
import { actionPath, fenced } from "../action-text.js";
import { hiddenCharacterSource } from "../agent-ssh-text.js";
import { mailTelegramApprovable } from "./agent-mail-send-input.js";

// The Telegram text of an agent's mail card (mail/agent-mail-sends.js): every
// recipient by its addr-spec, the sender, the subject and, when Telegram may decide
// it, the whole body; the result names the state, never the body.

/** The owner's mail copy for a channel, in the language stored on it. */
export const mailMessages = (channel) =>
  (serverCatalogs[channel?.language] || serverCatalogs.de).mail;

const hiddenAll = new RegExp(hiddenCharacterSource, "gu");
// Hidden characters as their code, so Telegram never draws them.
const visible = (text) =>
  String(text ?? "").replace(
    hiddenAll,
    (c) => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}>`,
  );

/**
 * A recipient as its addr-spec first, then any display name in quotes: a name that
 * looks like an address never stands where the address belongs.
 */
export function recipientText(entry) {
  const [parsed] = addressparser(String(entry ?? ""));
  const address = parsed?.address || String(entry ?? "");
  const name = parsed?.name || "";
  return visible(name ? `${address} ("${name}")` : address);
}

function header(p, m) {
  const f = m.mailFields;
  const from = p.from?.name
    ? `${p.from.address} ("${p.from.name}")`
    : String(p.from?.address ?? "");
  const lines = [`${f.from}: ${visible(from)}`];
  for (const key of ["to", "cc", "bcc"])
    for (const entry of p[key] ?? []) lines.push(`${f[key]}: ${recipientText(entry)}`);
  lines.push(`${f.subject}: ${visible(p.subject)}`);
  return fenced(lines.join("\n"));
}

function facts(w, action, m) {
  let agent = action.assistantId;
  try {
    agent = w.a.store.getAssistant(action.assistantId).name;
  } catch {}
  return [m.mailAgent(agent), m.mailAccount(action.payload.accountName ?? "")].join("\n");
}

// The final states a result names; anything else reads as unknown.
const finalStates = new Set([
  "completed",
  "declined",
  "expired",
  "cancelled",
  "failed",
  "unknown",
]);

function outcome(a, m) {
  const state = m.mailStates[finalStates.has(a.state) ? a.state : "unknown"];
  const code = a.result?.code || a.diagnostic;
  return a.state === "failed" && code ? `${state} · ${code}` : state;
}

/**
 * The approval and its result in the card's chat, queued like the SSH and SFTP
 * notices. Send and Don't send only for a mail Telegram shows in full
 * (mailTelegramApprovable); otherwise the text sends the owner to AgentPier.
 */
export function notifyMail(w, action, phase, key, m, target) {
  const p = action.payload;
  const approvable = mailTelegramApprovable(p);
  const text =
    phase === "approval"
      ? [
          m.mailApproval,
          facts(w, action, m),
          header(p, m),
          approvable ? fenced(String(p.body ?? "")) : m.mailOpenToApprove,
        ].join("\n\n")
      : [outcome(action, m), facts(w, action, m), header(p, m)].join("\n\n");
  const button = (decision, label) => ({
    proposalId: action.id,
    revision: action.revision,
    decision,
    label,
  });
  w.s.assistantChannels.outbox.enqueue({
    key,
    source: { ...target, actionId: action.id },
    kind: `action-${phase}`,
    localized: true,
    text,
    path: actionPath(action),
    actions:
      phase === "approval" && approvable
        ? [button("approve", m.mailSend), button("decline", m.mailDecline)]
        : [],
  });
}

/**
 * The chat note of a card that reached a final state (chatNotes.result, written by
 * MailSends.finish): its state and code, the account, how many recipients and the
 * subject. Never the body or an address.
 */
export function mailNotes(a) {
  const r = a.chatNotes?.result;
  if (!r) return [];
  const p = a.payload;
  const state = finalStates.has(a.state) ? a.state : "unknown";
  return [
    {
      id: `mail-run:${a.id}`,
      role: "event",
      event: "mail-run",
      actionId: a.id,
      state,
      code: ["failed", "unknown", "cancelled"].includes(state)
        ? a.result?.code || a.diagnostic || null
        : null,
      accountName: p.accountName ?? "",
      recipientCount: ["to", "cc", "bcc"].reduce((n, k) => n + (p[k]?.length ?? 0), 0),
      subject: p.subject ?? "",
      timestamp: r.at,
      runId: null,
      ...(a.memberName ? { memberName: a.memberName } : {}),
    },
  ];
}
