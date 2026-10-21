import React from "react";
import Icon from "../../../components/Icon.jsx";
import { usersCopy as copy } from "../../../lib/i18n/messages/users.js";

/**
 * In place of the groups an agent of users never has (user-agent-lock.js): why they
 * are locked, and which. `items` are keys of `lockedNames`.
 */
export default function LockedNotice({ items }) {
  return (
    <p className="agent-locked-notice" role="note">
      <Icon name="shield" size={16} />
      <span>
        {copy.locked}{" "}
        {copy.lockedList(items.map((key) => copy.lockedNames[key]).join(", "))}
      </span>
    </p>
  );
}
