import addressparser from "nodemailer/lib/addressparser";
import { serverCatalogs } from "../../../lib/i18n/catalogs.js";
import { formatBytes } from "../../operations/backup-components.js";
import { actionPath, fenced } from "../action-text.js";
import { hiddenCharacterSource, lineHiddenCharacterSource } from "../agent-ssh-text.js";
import { mailHtmlState, mailTelegramApprovable } from "./agent-mail-send-input.js";

// The Telegram text of an agent's mail card (mail/agent-mail-sends.js): every
// recipient by its addr-spec, the sender, the subject and, when Telegram may decide
// it, the whole body, with the forwarded original and every attachment by path, name,
// size, type and hash; the result names the state, never the body or a file.

/** The owner's mail copy for a channel, in the language stored on it. */
export const mailMessages = (channel) =>
  (serverCatalogs[channel?.language] || serverCatalogs.de).mail;

// A forwarded mail's date in the channel's language, in UTC; anything else as it is.
const dateFormats = Object.fromEntries(
  [
    ["en", "en-US"],
    ["de", "de-DE"],
  ].map(([language, locale]) => [
    language,
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }),
  ]),
);
function mailDate(date, m) {
  if (!Number.isFinite(Date.parse(date))) return visibleLine(date);
  const format = m === serverCatalogs.en?.mail ? dateFormats.en : dateFormats.de;
  return `${format.format(new Date(date))} UTC`;
}

const hiddenAll = new RegExp(hiddenCharacterSource, "gu");
const lineAll = new RegExp(lineHiddenCharacterSource, "gu");
const code = (c) => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}>`;
// Hidden characters as their code, so Telegram never draws them.
const visible = (text) => String(text ?? "").replace(hiddenAll, code);
// A single-line field (a name, a path, a header): line feed and tab as codes too, so
// it never breaks into a line of its own.
const visibleLine = (text) => String(text ?? "").replace(lineAll, code);

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

const pathLimit = 120;
// A path over pathLimit code points keeps its start and end around "…".
function shortPath(path) {
  const chars = Array.from(String(path ?? ""));
  if (chars.length <= pathLimit) return chars.join("");
  const head = Math.floor((pathLimit - 1) / 2);
  const tail = pathLimit - 1 - head;
  return [...chars.slice(0, head), "…", ...chars.slice(-tail)].join("");
}

function sourceText(source, f) {
  if (source?.kind === "original") return f.fromOriginal;
  if (!source?.path) return f.inDraft;
  const path = visibleLine(shortPath(source.path));
  return source.kind === "project" && source.projectName
    ? `${path} (${visibleLine(source.projectName)})`
    : path;
}

const htmlNotes = {
  kept: "mailHtmlKept",
  omitted: "mailHtmlOmitted",
  draft: "mailHtmlDraft",
};

/**
 * The forwarded original and every attachment, one line each, in one fenced block;
 * then which HTML version goes along (mailHtmlState). Empty for a plain mail.
 */
function attachmentsText(p, m) {
  const f = m.mailFields;
  const lines = [];
  if (p.forward) {
    const { from, subject, date } = p.forward;
    const sender = from?.name ? `${from.address} ("${from.name}")` : from?.address;
    const parts = [visibleLine(sender), visibleLine(subject), date && mailDate(date, m)];
    lines.push(`${f.forwardOf}: ${parts.filter(Boolean).join(" · ")}`);
  }
  for (const a of p.attachments ?? [])
    lines.push(
      `${f.attachment}: ${[
        sourceText(a.source, f),
        a.name ? visibleLine(a.name) : f.unnamed,
        formatBytes(a.size || 0),
        visibleLine(a.type),
        `sha256 ${a.sha256}`,
      ].join(" · ")}`,
    );
  const html = mailHtmlState(p);
  return [
    ...(lines.length ? [fenced(lines.join("\n"))] : []),
    ...(html ? [m[htmlNotes[html]]] : []),
  ];
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
          ...attachmentsText(p, m),
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
