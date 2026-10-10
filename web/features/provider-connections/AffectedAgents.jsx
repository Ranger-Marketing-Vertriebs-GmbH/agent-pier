import React from "react";
import { assistantCopy as messages } from "../../lib/i18n/messages/assistants.js";
// Names the agents that lose a connection the owner is about to delete; temporary
// team members are only counted.
export default function AffectedAgents({ affected }) {
  const copy = messages.connectionUse;
  const names = (affected?.agents || [])
    .map((a) => a?.name)
    .filter((n) => typeof n === "string");
  const members = Number.isSafeInteger(affected?.teamMembers) ? affected.teamMembers : 0;
  if (!names.length && !members) return null;
  return (
    <>
      {names.length > 0 && <p>{copy.agents(names)}</p>}
      {members > 0 && <p>{copy.members(members)}</p>}
    </>
  );
}
