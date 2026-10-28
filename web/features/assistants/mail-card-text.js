import { hasHiddenCharacters, hasLineHiddenCharacters } from "./ssh-command-text.js";

// The fields of an agent's mail card (MailApprovalCard.jsx). The server stores every
// recipient canonical (server/features/mail/mail-compose.js draftFields): the bare
// addr-spec, or `"Name" <addr-spec>` with `"` and `\` escaped in the name.

const quoted = /^"((?:[^"\\]|\\.)*)"\s*<([^<>]*)>$/;
const named = /^(.*?)\s*<([^<>]*)>$/;

/** `{ name, address }` of one recipient; the address is what the mail goes to. */
export function splitRecipient(entry) {
  const value = String(entry ?? "").trim();
  const q = quoted.exec(value);
  if (q) return { name: q[1].replace(/\\(.)/g, "$1"), address: q[2] };
  const n = named.exec(value);
  if (n) return { name: n[1].trim(), address: n[2] };
  return { name: "", address: value };
}

/**
 * The single-line texts of the card's attachments and forwarded original: the same
 * fields as the server's attachmentTexts (agent-mail-send-input.js; a unit test pins
 * both).
 */
export const mailLineTexts = (p) => [
  ...(p.attachments ?? []).flatMap((a) => [
    a.name,
    a.type,
    a.source?.path,
    a.source?.projectName,
  ]),
  p.forward?.from?.name,
  p.forward?.from?.address,
  p.forward?.subject,
];

/**
 * Whether anything the owner reads on the card hides a character; in a single-line
 * field (mailLineTexts) a line feed or tab counts too.
 */
export function mailHasHidden(p) {
  return (
    [
      p.body,
      p.subject,
      p.from?.name,
      ...(p.to ?? []),
      ...(p.cc ?? []),
      ...(p.bcc ?? []),
    ].some((text) => hasHiddenCharacters(text ?? "")) ||
    mailLineTexts(p).some((text) => hasLineHiddenCharacters(text ?? ""))
  );
}

/**
 * Which HTML version goes along: the original's in a forward ("kept"), none because
 * the original's was left out ("omitted"), the draft's own ("draft"), or null. As the
 * server's mailHtmlState (agent-mail-send-input.js).
 */
export function mailHtmlState(p) {
  if (p.forward)
    return p.forward.htmlIncluded || p.html
      ? "kept"
      : p.forward.htmlOmitted
        ? "omitted"
        : null;
  return p.html ? "draft" : null;
}

export const bodyLines = (text) => String(text ?? "").split("\n").length;
