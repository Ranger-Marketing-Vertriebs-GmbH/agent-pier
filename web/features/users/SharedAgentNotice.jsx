import React from "react";
import { userAppCopy as copy } from "../../lib/i18n/messages/user-app.js";

/**
 * Above a shared agent's composer: her chat stays private, but the agent's memory,
 * its USER.md profile and its browser are the same for everyone who uses it.
 */
export default function SharedAgentNotice() {
  return (
    <p className="user-chat-notice shared" role="note">
      <strong>{copy.sharedTitle}</strong> {copy.sharedBody}
    </p>
  );
}
