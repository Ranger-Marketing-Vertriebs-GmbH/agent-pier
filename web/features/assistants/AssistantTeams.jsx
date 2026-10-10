import React, { useEffect, useState } from "react";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import useAssistants from "./useAssistants.js";
import { assistantApi } from "./assistant-api.js";
import TeamCodingRequests from "./TeamCodingRequests.jsx";
import useTeamCodingRequests from "./useTeamCodingRequests.js";
export default function AssistantTeams({ assistant, focusTeamId, navigate }) {
  const { teams = [], members = [], refresh } = useAssistants();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [archived, setArchived] = useState(false);
  // A deep link to a team task (from a Telegram notice) shows that team.
  const focused = teams.some((t) => t.id === focusTeamId);
  useEffect(() => {
    if (focused)
      document
        .getElementById(`assistant-team-${focusTeamId}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [focusTeamId, focused]);
  const member = members.find((m) => m.assistantId === assistant.id);
  const coding = useTeamCodingRequests(
    assistant.id,
    !member && teams.some((t) => t.parentAssistantId === assistant.id),
    teams,
  );
  async function act(operation) {
    setBusy(true);
    setError("");
    try {
      await operation();
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (member)
    return (
      <div className="assistant-member-summary">
        <strong>
          {member.role} · {copy.team.states[member.phase]}
        </strong>
        <p>{member.assignment}</p>
      </div>
    );
  const own = teams.filter((t) => t.parentAssistantId === assistant.id);
  if (!own.length) return null;
  return (
    <section className="assistant-teams" aria-label={copy.team.title}>
      <ErrorMessage error={error || coding.error} />
      {own
        .filter((t) => archived || !t.archivedAt || t.id === focusTeamId)
        .map((team) => (
          <details
            key={team.id}
            id={`assistant-team-${team.id}`}
            open={
              team.phase === "awaiting_approval" ||
              team.id === focusTeamId ||
              // A member's coding request waiting for the owner is decided here.
              coding.actions.some(
                (a) => a.teamId === team.id && a.state === "awaiting_approval",
              )
            }
            className="assistant-team-card"
          >
            <summary>
              <strong>{team.objective}</strong>
              <span>{copy.team.states[team.status || team.phase]}</span>
            </summary>
            {team.ownerRequestQuote && (
              <p className="assistant-team-reason">
                {copy.team.startedBecause(team.ownerRequestQuote)}
              </p>
            )}
            {team.phase === "awaiting_approval" ? (
              <>
                <p>{copy.team.approvalHint}</p>
                <ul>
                  {team.members.map((m, n) => (
                    <li key={n}>
                      <strong>
                        {m.name} · {m.role}
                      </strong>
                      <p>{m.assignment}</p>
                    </li>
                  ))}
                </ul>
                <div className="assistant-actions">
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy}
                    onClick={() =>
                      act(() =>
                        assistantApi.decideTeam(team.id, {
                          revision: team.revision,
                          decision: "approve",
                          lifetime: "task",
                        }),
                      )
                    }
                  >
                    {copy.team.approve}
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      act(() =>
                        assistantApi.decideTeam(team.id, {
                          revision: team.revision,
                          decision: "decline",
                        }),
                      )
                    }
                  >
                    {copy.team.decline}
                  </button>
                </div>
              </>
            ) : (
              <>
                <ul className="assistant-team-members">
                  {members
                    .filter((m) => m.teamId === team.id)
                    .map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() =>
                            navigate({
                              view: "agents",
                              assistantId: m.assistantId,
                              ...(m.conversationId
                                ? { conversationId: m.conversationId }
                                : { agentSettings: true }),
                            })
                          }
                        >
                          {m.name}
                        </button>
                        <span>
                          {m.role} · {copy.team.states[m.phase]}
                        </span>
                        <p>{m.assignment}</p>
                      </li>
                    ))}
                </ul>
                <TeamCodingRequests
                  actions={coding.actions.filter((a) => a.teamId === team.id)}
                  busy={busy}
                  onDecide={(a, decision) => act(() => coding.decide(a, decision))}
                />
                <div className="assistant-actions">
                  {!["completed", "failed", "cancelled", "declined"].includes(
                    team.phase,
                  ) && (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        act(() => assistantApi.teamAction("teams", team.id, "stop"))
                      }
                    >
                      {copy.team.stopTeam}
                    </button>
                  )}
                  {["completed", "failed", "cancelled", "declined"].includes(
                    team.phase,
                  ) && (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        act(() =>
                          assistantApi.teamAction(
                            "teams",
                            team.id,
                            team.archivedAt ? "restore" : "archive",
                            team.revision,
                          ),
                        )
                      }
                    >
                      {team.archivedAt ? copy.team.restore : copy.team.archive}
                    </button>
                  )}
                </div>
              </>
            )}
          </details>
        ))}
      {own.some((t) => t.archivedAt) && (
        <label>
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          {copy.team.showArchived}
        </label>
      )}
    </section>
  );
}
