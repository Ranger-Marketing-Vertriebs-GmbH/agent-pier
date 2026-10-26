import React, { useId, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import Segmented from "../../../components/Segmented.jsx";
import { routePath } from "../../../app/routes.js";
import { agentsHubCopy } from "../../../lib/i18n/messages/agents-hub.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { agentsHubRoute } from "../hub-routes.js";
import TeamProposalCard from "../TeamProposalCard.jsx";
import useAssistants from "../useAssistants.js";
import useTeamActions from "../useTeamActions.js";
import useTeamCodingRequests from "../useTeamCodingRequests.js";
import MemberRequests from "../settings/MemberRequests.jsx";
import TeamCard from "../settings/TeamCard.jsx";

const copy = () => agentsHubCopy.teams;
const teamCopy = () => assistantCopy.team;

/** One lead's started teams, with the coding requests of its members. */
function LeadTeams({ lead, teams, allTeams, members, busy, act, navigate }) {
  const coding = useTeamCodingRequests(lead.id, teams.length > 0, allTeams);
  const id = useId();
  return (
    <section className="agents-hub-lead" aria-labelledby={id}>
      <h3 id={id} className="agents-hub-lead-name">
        {copy().lead(lead.name)}
      </h3>
      <ErrorMessage error={coding.error} />
      {teams.map((team) => (
        <TeamCard
          key={team.id}
          team={team}
          members={members.filter((m) => m.teamId === team.id)}
          coding={coding.actions.filter((a) => a.teamId === team.id)}
          busy={busy}
          act={act}
          onDecideCoding={(a, decision) => act(() => coding.decide(a, decision))}
          navigate={navigate}
        />
      ))}
    </section>
  );
}

/**
 * Teams (handoff 5.2): the teams of every lead, from the same team list the agent's
 * Team tab reads (GET /api/assistant-teams arrives with the agents list), with the
 * same actions and endpoints: proposals, team cards, member requests, and the
 * host-wide member limit linking to Runtime.
 */
export default function HubTeamsTab({ navigate }) {
  const {
    assistants = [],
    teams = [],
    members = [],
    requests = [],
    teamSettings,
  } = useAssistants();
  const { busy, error, act } = useTeamActions();
  const [view, setView] = useState("active");
  const proposalsId = useId(),
    teamsId = useId();
  const byId = new Map(assistants.map((a) => [a.id, a]));
  const leadOf = (team) =>
    byId.get(team.parentAssistantId) || {
      id: team.parentAssistantId,
      name: team.parentName || "",
    };
  const archived = teams.filter((t) => t.archivedAt);
  const active = teams.filter((t) => !t.archivedAt);
  const shown = view === "archived" ? archived : active;
  const proposals = shown.filter((t) => t.phase === "awaiting_approval").reverse();
  const started = shown.filter((t) => t.phase !== "awaiting_approval");
  const leads = [...new Set(started.map((t) => t.parentAssistantId))].map((id) => ({
    lead: leadOf(started.find((t) => t.parentAssistantId === id)),
    teams: started.filter((t) => t.parentAssistantId === id).reverse(),
  }));
  const requestLeads = [...new Set(requests.map((r) => r.parentAssistantId))]
    .map((id) => byId.get(id))
    .filter(Boolean);
  const runtime = agentsHubRoute("runtime");
  return (
    <>
      <div className="agents-hub-teams-head">
        <Segmented
          label={copy().filterLabel}
          value={view}
          onChange={setView}
          options={[
            { value: "active", label: teamCopy().active(active.length) },
            { value: "archived", label: teamCopy().archived(archived.length) },
          ]}
        />
        <p className="field-description">{copy().hint}</p>
      </div>
      <ErrorMessage error={error} />
      {proposals.length > 0 && (
        <section aria-labelledby={proposalsId}>
          <GroupLabel id={proposalsId}>
            {copy().proposals}
            <span className="agents-hub-pill accent">
              {copy().open(proposals.length)}
            </span>
          </GroupLabel>
          <div className="agent-teams">
            {proposals.map((team) => (
              <TeamProposalCard key={team.id} team={team} busy={busy} act={act} />
            ))}
          </div>
        </section>
      )}
      <section aria-labelledby={teamsId}>
        <GroupLabel id={teamsId}>
          {copy().teams}
          <span className="agents-hub-count">{started.length}</span>
        </GroupLabel>
        <div className="agent-teams">
          {leads.map(({ lead, teams: own }) => (
            <LeadTeams
              key={lead.id}
              lead={lead}
              teams={own}
              allTeams={teams}
              members={members}
              busy={busy}
              act={act}
              navigate={navigate}
            />
          ))}
          {!started.length && (
            <p className="agent-teams-empty">
              {view === "archived" ? copy().noArchived : copy().none}
            </p>
          )}
        </div>
      </section>
      {requestLeads.length > 0 && (
        <div className="agents-hub-requests">
          {requestLeads.map((lead) => (
            <div key={lead.id} className="agents-hub-lead">
              <h3 className="agents-hub-lead-name">{copy().lead(lead.name)}</h3>
              <MemberRequests
                assistant={lead}
                requests={requests}
                members={members}
                busy={busy}
                act={act}
                navigate={navigate}
              />
            </div>
          ))}
        </div>
      )}
      {teamSettings?.hostMaxConcurrent !== undefined && (
        <p className="field-description">
          {copy().capacity(teamSettings.hostMaxConcurrent)} ·{" "}
          <a
            href={routePath(runtime)}
            onClick={(event) => {
              event.preventDefault();
              navigate(runtime);
            }}
          >
            {copy().capacityLink}
          </a>
        </p>
      )}
    </>
  );
}
