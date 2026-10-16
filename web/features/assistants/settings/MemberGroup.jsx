import React, { useId, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";
import useAssistants from "../useAssistants.js";
import { assistantApi } from "../assistant-api.js";

/** Provenance, assignment, phase and lifecycle actions of a team member. */
export default function MemberGroup({ assistant }) {
  const { members = [], assistants, refresh } = useAssistants();
  const member = members.find((m) => m.assistantId === assistant.id);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const id = useId();
  if (!member) return null;
  const parent = assistants.find((a) => a.id === member.parentAssistantId),
    active = !["completed", "failed", "cancelled"].includes(member.phase);
  async function action(name) {
    setBusy(true);
    try {
      if (name === "recover")
        await assistantApi.recoverTeamMember(member.id, member.revision);
      else
        await assistantApi.teamAction(
          "team-members",
          member.id,
          name,
          name === "stop" ? undefined : member.revision,
        );
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="agent-member" aria-labelledby={id}>
      <GroupLabel id={id}>{copy.team.memberSettings}</GroupLabel>
      <ErrorMessage error={error} />
      <div className="list-card agent-member-card">
        <p>{copy.team.inherited(parent?.name || copy.title, member.inheritedRevision)}</p>
        <p>
          {member.lifetime === "permanent" ? copy.team.permanent : copy.team.taskBound}
        </p>
        <p className="assistant-note">
          {member.lifetime === "permanent"
            ? copy.team.independent
            : copy.team.independentTask}
        </p>
        {member.overrides && (
          <div className="assistant-member-provenance">
            {"model" in member.overrides && (
              <p>
                {member.overrides.model
                  ? copy.team.modelChanged
                  : copy.team.modelOriginal}
              </p>
            )}
            <p>
              {member.overrides.instructions
                ? copy.team.instructionsChanged
                : copy.team.instructionsOriginal}
            </p>
          </div>
        )}
        <p>{member.assignment}</p>
        <p>{copy.team.states[member.phase]}</p>
        {member.phase === "provisioning_uncertain" && (
          <div className="assistant-notice">
            <p>{copy.team.setupUnknown}</p>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => action("recover")}
            >
              {copy.recover}
            </button>
          </div>
        )}
        <div className="assistant-actions">
          {active ? (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => action("stop")}
            >
              {copy.team.stopMember}
            </button>
          ) : (
            <>
              {member.lifetime !== "permanent" && (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => action("promote")}
                >
                  {copy.team.promote}
                </button>
              )}
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => action(member.archivedAt ? "restore" : "archive")}
              >
                {member.archivedAt ? copy.team.restore : copy.team.archive}
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
