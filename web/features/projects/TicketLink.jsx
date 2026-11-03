import React from "react";
import { ticketHref, ticketLinkLabel } from "./ticket-list.js";

// A session's or run's ticket: a link to the tracker (http(s) only) or plain text.
// `text(label)` is the localized sentence around the "<key> · <title>" label.
export default function TicketLink({ ticket, text, className }) {
  const label = ticketLinkLabel(ticket);
  if (!label) return null;
  const href = ticketHref(ticket);
  return href ? (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {text(label)}
    </a>
  ) : (
    <span className={className}>{text(label)}</span>
  );
}
