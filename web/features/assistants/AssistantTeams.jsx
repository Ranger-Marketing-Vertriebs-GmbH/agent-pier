import React, { useEffect, useState } from "react";
import Icon from "../../components/Icon.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { mcpServerCopy as mcpCopy } from "../../lib/i18n/messages/mcp-servers.js";
import "../mcp-servers/mcp-servers.css";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import useAssistants from "./useAssistants.js";
import { assistantApi } from "./assistant-api.js";
import { avatarGlyph } from "./avatar-glyph.js";
import TeamCodingRequests from "./TeamCodingRequests.jsx";
import useTeamCodingRequests from "./useTeamCodingRequests.js";
import { scrollToChild } from "./transcript-scroll.js";

const finished = ["completed", "failed", "cancelled", "declined"];
// Member phases shown quietly; every other phase is in progress and uses the accent.
const quiet = new Set(["ready", "completed", "cancelled", "declined"]);

export default function AssistantTeams({ assistant, focusTeamId, navigate }) {
  const { teams = [], members = [], refresh } = useAssistants();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [archived, setArchived] = useState(false);
  // A deep link to a team task (from a Telegram notice) shows that team.
  const focused = teams.some((t) => t.id === focusTeamId);
  useEffect(() => {
    if (!focused) return;
    const card = document.getElementById(`assistant-team-${focusTeamId}`);
    scrollToChild(card?.closest(".assistant-transcript"), card);
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
  // A member's chat shows its team context above the transcript instead.
  if (member) return null;
  const own = teams.filter((t) => t.parentAssistantId === assistant.id);
  if (!own.length) return null;
  // A member's coding request waiting for the owner is decided in its team card.
  const codingPending = (team) =>
    coding.actions.some((a) => a.teamId === team.id && a.state === "awaiting_approval");
  return (
    <section className="assistant-teams" aria-label={copy.team.title}>
      <ErrorMessage error={error || coding.error} />
      {own
        .filter((t) => archived || !t.archivedAt || t.id === focusTeamId)
        .map((team) => {
          const awaiting = team.phase === "awaiting_approval";
          const teamMembers = members.filter((m) => m.teamId === team.id);
          const state = copy.team.states[team.status || team.phase];
          // An unreadable MCP server list blocks the approval until it can be read.
          const unavailable =
            awaiting && team.members.some((m) => m.mcpServersUnavailable);
          return (
            <details
              key={team.id}
              id={`assistant-team-${team.id}`}
              data-pending={awaiting || codingPending(team) ? "" : undefined}
              open={awaiting || team.id === focusTeamId || codingPending(team)}
              className={`assistant-team-card${awaiting ? " awaiting" : ""}`}
            >
              <summary>
                <span className="assistant-team-icon" aria-hidden="true">
                  <Icon name="users" size={15} />
                </span>
                <span className="assistant-team-title">
                  <strong>{team.objective}</strong>
                  <span>
                    {awaiting || !teamMembers.length
                      ? state
                      : `${state} · ${copy.memberCount(teamMembers.length)}`}
                  </span>
                </span>
                {!awaiting && (
                  <Icon name="chevron" size={16} className="assistant-team-chevron" />
                )}
              </summary>
              {team.ownerRequestQuote && (
                <p className="assistant-team-reason">
                  {copy.team.startedBecause(team.ownerRequestQuote)}
                </p>
              )}
              {awaiting ? (
                <>
                  <p className="assistant-team-hint">{copy.team.approvalHint}</p>
                  <ul className="assistant-team-proposal">
                    {team.members.map((m, n) => (
                      <li key={n}>
                        <span className="assistant-avatar" aria-hidden="true">
                          {avatarGlyph(m.name)}
                        </span>
                        <span>
                          <strong>
                            {m.name} · {m.role}
                          </strong>
                          <small>{m.assignment}</small>
                          {m.mcpServers?.length > 0 && (
                            <small className="mcp-team-servers">
                              {mcpCopy.teamServers}:{" "}
                              {m.mcpServers.map((server, index) => (
                                <span key={server.name}>
                                  {index > 0 && ", "}
                                  {server.name}
                                  {server.stdio && ` (${mcpCopy.stdioMarker})`}
                                </span>
                              ))}
                            </small>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {unavailable && (
                    <p className="mcp-team-warning blocking" role="alert">
                      {mcpCopy.teamServersUnavailable}
                    </p>
                  )}
                  {team.members.some((m) => m.mcpServers?.some((s) => s.stdio)) && (
                    <p className="mcp-team-warning notice">{mcpCopy.teamStdioWarning}</p>
                  )}
                  <div className="assistant-card-actions">
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy || unavailable}
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
                    {teamMembers.map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          className="assistant-team-member"
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
                          <span className="assistant-avatar" aria-hidden="true">
                            {avatarGlyph(m.name)}
                          </span>
                          <span className="assistant-team-member-text">
                            <strong>{m.name}</strong>
                            <small>
                              <span className={quiet.has(m.phase) ? undefined : "active"}>
                                {copy.team.states[m.phase]}
                              </span>
                              {m.assignment ? ` · ${m.assignment}` : ""}
                            </small>
                          </span>
                          <Icon name="chevron" size={16} />
                        </button>
                      </li>
                    ))}
                  </ul>
                  <TeamCodingRequests
                    actions={coding.actions.filter((a) => a.teamId === team.id)}
                    busy={busy}
                    onDecide={(a, decision) => act(() => coding.decide(a, decision))}
                  />
                  <div className="assistant-card-actions">
                    {!finished.includes(team.phase) && (
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
                    {finished.includes(team.phase) && (
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
          );
        })}
      {own.some((t) => t.archivedAt) && (
        <label className="assistant-team-archived">
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
