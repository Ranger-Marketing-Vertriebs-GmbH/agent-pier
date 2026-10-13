import React, { useEffect, useId, useRef, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import Segmented from "../../../components/Segmented.jsx";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import TeamProposalCard from "../TeamProposalCard.jsx";
import useAssistants from "../useAssistants.js";
import useTeamActions from "../useTeamActions.js";
import useTeamCodingRequests from "../useTeamCodingRequests.js";
import { scrollParent, scrollToChild } from "../transcript-scroll.js";
import TeamCard from "./TeamCard.jsx";

const copy = assistantCopy.team;

/**
 * Settings → Work → Teams: every team of a lead, active or archived. A chat note's
 * link (`team=<id>`) opens the list on that team's side with the team expanded.
 */
export default function TeamsGroup({ assistant, focusTeamId, navigate }) {
  const { teams = [], members = [] } = useAssistants();
  const own = teams.filter((t) => t.parentAssistantId === assistant.id);
  const coding = useTeamCodingRequests(assistant.id, own.length > 0, teams);
  const { busy, error, act } = useTeamActions();
  const labelId = useId();
  const focus = own.find((t) => t.id === focusTeamId);
  const [view, setView] = useState(focus?.archivedAt ? "archived" : "active");
  // The focused team may arrive with a later list: once it is known, the list opens
  // on its side and scrolls to it. Later archiving or restoring does not switch sides.
  const focusSide = focus ? (focus.archivedAt ? "archived" : "active") : "";
  const applied = useRef("");
  useEffect(() => {
    if (!focusSide || applied.current === focusTeamId) return;
    applied.current = focusTeamId;
    setView(focusSide);
  }, [focusSide, focusTeamId]);
  const focusShown = focusSide !== "" && focusSide === view;
  useEffect(() => {
    if (!focusShown) return;
    const card = document.getElementById(`assistant-team-${focusTeamId}`);
    if (!card) return;
    scrollToChild(scrollParent(card), card);
    card.querySelector(":scope > summary")?.focus({ preventScroll: true });
  }, [focusShown, focusTeamId]);
  const archived = own.filter((t) => t.archivedAt);
  const active = own.filter((t) => !t.archivedAt);
  // Newest first.
  const shown = [...(view === "archived" ? archived : active)].reverse();
  return (
    <section id="agent-teams" aria-labelledby={labelId}>
      <GroupLabel id={labelId} hint={copy.listHint}>
        {copy.title}
      </GroupLabel>
      <ErrorMessage error={error || coding.error} />
      {own.length ? (
        <div className="agent-teams">
          <Segmented
            label={copy.filterLabel}
            className="agent-teams-filter"
            value={view}
            onChange={setView}
            options={[
              { value: "active", label: copy.active(active.length) },
              { value: "archived", label: copy.archived(archived.length) },
            ]}
          />
          {shown.map((team) =>
            team.phase === "awaiting_approval" ? (
              <TeamProposalCard key={team.id} team={team} busy={busy} act={act} />
            ) : (
              <TeamCard
                key={team.id}
                team={team}
                members={members.filter((m) => m.teamId === team.id)}
                coding={coding.actions.filter((a) => a.teamId === team.id)}
                busy={busy}
                act={act}
                onDecideCoding={(a, decision) => act(() => coding.decide(a, decision))}
                focused={team.id === focusTeamId}
                navigate={navigate}
              />
            ),
          )}
          {!shown.length && (
            <p className="agent-teams-empty">
              {view === "archived" ? copy.noArchived : copy.noActive}
            </p>
          )}
        </div>
      ) : (
        <p className="agent-teams-empty">{copy.noTeams}</p>
      )}
    </section>
  );
}
