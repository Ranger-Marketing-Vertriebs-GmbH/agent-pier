import React from "react";
import { userAppCopy as copy } from "../../lib/i18n/messages/user-app.js";

/**
 * Above a shared agent's composer: other users never see her chat, but the agent's
 * memory, its USER.md profile and its browser are the same for everyone who uses it.
 * While the owner may read her chats (OwnerReadsNotice below) it never calls the chat
 * private.
 */
export default function SharedAgentNotice({ ownerReads = false }) {
  return (
    <p className="user-chat-notice shared" role="note">
      <strong>{copy.sharedTitle}</strong>{" "}
      {ownerReads ? copy.sharedBodyRead : copy.sharedBody}
    </p>
  );
}
