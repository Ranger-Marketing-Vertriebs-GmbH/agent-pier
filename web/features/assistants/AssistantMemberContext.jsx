import React, { useState } from "react";
import Icon from "../../components/Icon.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import useAssistants from "./useAssistants.js";
import { assistantApi } from "./assistant-api.js";

const terminal = ["completed", "failed", "cancelled"];

// Where a team member's chat comes from (handoff 2d): back to the parent's team, the
// assignment, and a stop while the member works. Replaces the old summary card.
export default function AssistantMemberContext({ member, navigate }) {
  const { teams = [], assistants = [], refresh } = useAssistants();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const team = teams.find((t) => t.id === member.teamId);
  const parent = assistants.find((a) => a.id === member.parentAssistantId);
  const linked =
    team?.parentConversationId &&
    parent &&
    !team.archivedAt &&
    !parent.archivedAt &&
    member.lifetime !== "permanent";
  async function stop() {
    setBusy(true);
    setError("");
    try {
      await assistantApi.teamAction("team-members", member.id, "stop");
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const assignment = (
    <span className="assistant-member-assignment">{member.assignment}</span>
  );
  return (
    <>
      <div className="assistant-member-context">
        {linked ? (
          <button
            type="button"
            className="assistant-member-back"
            onClick={() =>
              navigate({ view: "agents", assistantId: parent.id, teamId: team.id })
            }
          >
            <span className="assistant-member-origin">
              <Icon name="back" size={14} />
              <span>
                {parent.name} · {team.objective}
              </span>
            </span>
            {assignment}
          </button>
        ) : (
          <div className="assistant-member-back">
            <span className="assistant-member-origin">
              <span>{member.role}</span>
            </span>
            {assignment}
          </div>
        )}
        {!terminal.includes(member.phase) && (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={stop}
          >
            {copy.team.stopMember}
          </button>
        )}
      </div>
      <ErrorMessage error={error} />
    </>
  );
}
