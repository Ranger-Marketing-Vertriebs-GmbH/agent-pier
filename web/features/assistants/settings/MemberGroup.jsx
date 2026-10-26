import React, { useId } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";
import useAssistants from "../useAssistants.js";
import MemberHistory from "./MemberHistory.jsx";
import useMemberLifecycle from "./useMemberLifecycle.js";

/**
 * Provenance, assignment, phase and lifecycle actions of a team member (Overview).
 * Archive and restore sit in the Verwalten group beside it.
 */
export default function MemberGroup({ assistant }) {
  const { assistants } = useAssistants();
  const { member, active, busy, error, act: action } = useMemberLifecycle(assistant);
  const id = useId();
  if (!member) return null;
  const parent = assistants.find((a) => a.id === member.parentAssistantId);
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
        {/* A task member shows its history under Capabilities; a permanent one has no such block. */}
        {member.lifetime === "permanent" && <MemberHistory member={member} />}
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
            member.lifetime !== "permanent" && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => action("promote")}
              >
                {copy.team.promote}
              </button>
            )
          )}
        </div>
      </div>
    </section>
  );
}
