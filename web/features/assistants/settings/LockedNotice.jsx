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

/**
 * What the owner sees of a user's own agent (owner-privacy.js): `private` until her
 * opt-in, then `read` (read only), or null for any other agent.
 */
export const ownContent = (assistant) =>
  assistant?.userAccess?.mode === "own"
    ? assistant.ownerReads
      ? "read"
      : "private"
    : null;

/** Why a user's own agent's notes and browser are hidden or read-only for the owner. */
export function OwnContentNotice({ own }) {
  if (!own) return null;
  return (
    <p className="agent-locked-notice" role="note">
      <Icon name="shield" size={16} />
      <span>{own === "read" ? copy.ownReadOnly : copy.ownPrivate}</span>
    </p>
  );
}
