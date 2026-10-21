import React from "react";
import Icon from "../../components/Icon.jsx";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { userAppCopy as copy } from "../../lib/i18n/messages/user-app.js";

/**
 * Whether the owner may read her chats: while the opt-in is on she sees, in every
 * chat, from when he may; otherwise her own agent's chat says it is private. A
 * shared agent's notice (SharedAgentNotice) already says that.
 */
export default function OwnerReadsNotice({ ownerMayRead, shared = false }) {
  if (ownerMayRead?.enabled)
    return (
      <p className="user-chat-notice reads" role="note">
        <Icon name="info" size={14} />
        {copy.ownerReads(formatTimestamp(ownerMayRead.since))}
      </p>
    );
  if (shared) return null;
  return (
    <p className="user-chat-notice private" role="note">
      <Icon name="shield" size={14} />
      {copy.private}
    </p>
  );
}
