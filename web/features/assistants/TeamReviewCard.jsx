import React from "react";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import RouteLink from "./RouteLink.jsx";

const review = new Set(["uncertain", "provisioning_uncertain"]);
/** A member whose setup or turn outcome is unknown waits for the owner's review. */
export const awaitingReview = (member) => review.has(member.phase) && !member.archivedAt;

// Members of one team whose outcome is unknown. The owner reviews a turn in the
// member's chat and acknowledges an unknown setup in its settings (Recover).
export default function TeamReviewCard({ team, members, navigate }) {
  return (
    <article
      id={`assistant-team-review-${team.id}`}
      className="assistant-approval-card"
      data-pending=""
      aria-label={copy.team.reviewTitle(team.objective)}
    >
      <div className="assistant-approval-head">
        <strong className="assistant-team-clamp" title={team.objective}>
          {team.objective}
        </strong>
        <small>{copy.team.awaitingReview}</small>
      </div>
      <p>{copy.team.reviewHint}</p>
      {members.map((m) => (
        <div key={m.id} className="assistant-team-review">
          <p className="assistant-approval-task">
            {m.name}: {copy.team.states[m.phase]}
          </p>
          <RouteLink
            className="button secondary"
            route={{
              view: "agents",
              assistantId: m.assistantId,
              ...(m.conversationId
                ? { conversationId: m.conversationId }
                : { agentSettings: true }),
            }}
            navigate={navigate}
          >
            {copy.team.reviewMember(m.name)}
          </RouteLink>
        </div>
      ))}
    </article>
  );
}
