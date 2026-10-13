import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import TeamCodingRequests from "./TeamCodingRequests.jsx";
import TeamProposalCard from "./TeamProposalCard.jsx";
import TeamReviewCard, { awaitingReview } from "./TeamReviewCard.jsx";
import useAssistants from "./useAssistants.js";
import useTeamActions from "./useTeamActions.js";
import useTeamCodingRequests from "./useTeamCodingRequests.js";

// What a lead's teams need from the owner stays in the chat until it is decided:
// team proposals, the members' coding requests and members whose outcome is unknown
// (the team cannot end until the owner reviews them). Everything else about the
// teams lives in Settings → Work → Teams.
export default function TeamApprovals({ assistant, navigate }) {
  const { teams = [], members = [] } = useAssistants();
  const own = teams.filter((t) => t.parentAssistantId === assistant.id);
  const coding = useTeamCodingRequests(assistant.id, own.length > 0, teams);
  const { busy, error, act } = useTeamActions();
  const proposals = own.filter((t) => t.phase === "awaiting_approval" && !t.archivedAt);
  const requests = coding.actions.filter((a) => a.state === "awaiting_approval");
  const asking = own.filter((t) => requests.some((a) => a.teamId === t.id));
  const unknown = members.filter(
    (m) => awaitingReview(m) && own.some((t) => t.id === m.teamId),
  );
  const reviewing = own.filter((t) => unknown.some((m) => m.teamId === t.id));
  if (!proposals.length && !asking.length && !reviewing.length && !error && !coding.error)
    return null;
  return (
    <section className="assistant-team-approvals" aria-label={copy.team.pendingTitle}>
      <ErrorMessage error={error || coding.error} />
      {proposals.map((team) => (
        <TeamProposalCard key={team.id} team={team} busy={busy} act={act} />
      ))}
      {reviewing.map((team) => (
        <TeamReviewCard
          key={team.id}
          team={team}
          members={unknown.filter((m) => m.teamId === team.id)}
          navigate={navigate}
        />
      ))}
      {asking.map((team) => (
        <TeamCodingRequests
          key={team.id}
          id={`assistant-team-requests-${team.id}`}
          title={team.objective}
          actions={requests.filter((a) => a.teamId === team.id)}
          busy={busy}
          onDecide={(a, decision) => act(() => coding.decide(a, decision))}
        />
      ))}
    </section>
  );
}
