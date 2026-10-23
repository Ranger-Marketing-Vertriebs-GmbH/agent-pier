import React from "react";
import { memberGrantCopy as grantCopy } from "../../../lib/i18n/messages/assistant-member-grants.js";
import { logText } from "../member-grants.js";
import ReplacedInstructions from "./ReplacedInstructions.jsx";

/** The lead's changes to a member (grants and edits), newest first; nothing without any. */
export default function MemberHistory({ member }) {
  const log = member?.grantLog || [];
  if (!log.length) return null;
  return (
    <>
      <h3 className="agent-granted-history">{grantCopy.history}</h3>
      <ul className="agent-granted-log" data-grant-log="">
        {[...log].reverse().map((entry, n) => (
          <li key={n}>
            {logText(entry)}
            {entry.replaced && (
              <ReplacedInstructions memberId={member.id} entryId={entry.replaced} />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
