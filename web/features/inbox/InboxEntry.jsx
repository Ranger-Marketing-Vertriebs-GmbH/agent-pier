import React from "react";
import Icon from "../../components/Icon.jsx";
import { inboxCopy as copy } from "../../lib/i18n/messages/inbox.js";
import { useInboxCount } from "./inbox-store.js";
import "./inbox-entry.css";

const badge = (count) => (count > 99 ? "99+" : String(count));

// The fixed sidebar entry under "New", with the live count of waiting items.
export default function InboxEntry({ active, onOpen }) {
  const count = useInboxCount();
  return (
    <button
      type="button"
      className={`inbox-entry ${active ? "selected" : ""} ${count ? "waiting" : ""}`}
      aria-current={active ? "page" : undefined}
      aria-label={copy.entryLabel(count)}
      onClick={onOpen}
    >
      <Icon name="inbox" size={17} />
      <span className="inbox-entry-label">{copy.title}</span>
      {count > 0 && (
        <span className="inbox-count" aria-hidden="true">
          {badge(count)}
        </span>
      )}
    </button>
  );
}

// The phone header's inbox icon; the badge shows while anything waits.
export function InboxHeaderButton({ onOpen }) {
  const count = useInboxCount();
  return (
    <button
      type="button"
      className="icon-button inbox-header-button"
      aria-label={copy.openInbox(count)}
      title={copy.title}
      onClick={onOpen}
    >
      <Icon name="inbox" />
      {count > 0 && (
        <span className="inbox-badge" aria-hidden="true">
          {badge(count)}
        </span>
      )}
    </button>
  );
}
