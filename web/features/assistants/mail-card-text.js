import { hasHiddenCharacters } from "./ssh-command-text.js";

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

/** Whether anything the owner reads on the card hides a character. */
export function mailHasHidden(p) {
  return [
    p.body,
    p.subject,
    p.from?.name,
    ...(p.to ?? []),
    ...(p.cc ?? []),
    ...(p.bcc ?? []),
    ...(p.attachments ?? []).flatMap((a) => [a.name, a.source?.path]),
    p.forward?.from?.name,
    p.forward?.from?.address,
    p.forward?.subject,
  ].some((text) => hasHiddenCharacters(text ?? ""));
}

export const bodyLines = (text) => String(text ?? "").split("\n").length;
