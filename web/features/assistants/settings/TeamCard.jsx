import React from "react";
import Icon from "../../../components/Icon.jsx";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";
import { assistantApi } from "../assistant-api.js";
import { avatarGlyph } from "../avatar-glyph.js";
import RouteLink from "../RouteLink.jsx";
import TeamCodingRequests from "../TeamCodingRequests.jsx";
import TeamReport from "./TeamReport.jsx";

const finished = ["completed", "failed", "cancelled", "declined"];
// Member phases shown quietly; every other phase is in progress and uses the accent.
const quiet = new Set(["ready", "completed", "cancelled", "declined"]);

/** One started team in Settings → Work → Teams: members, results and its actions. */
export default function TeamCard({
  team,
  members,
  coding,
  busy,
  act,
  onDecideCoding,
  focused,
  navigate,
}) {
  const state = copy.team.states[team.status || team.phase];
  const pending = coding.some((a) => a.state === "awaiting_approval");
  const reports = new Map((team.resultBatch || []).map((r) => [r.memberId, r]));
  const result =
    team.resultState &&
    (copy.team.results[team.resultState] || copy.team.results.pending);
  return (
    <details
      id={`assistant-team-${team.id}`}
      data-pending={pending ? "" : undefined}
      data-focused={focused ? "" : undefined}
      open={focused || pending}
      className="assistant-team-card"
    >
      <summary>
        <span className="assistant-team-icon" aria-hidden="true">
          <Icon name="users" size={15} />
        </span>
        <span className="assistant-team-title">
          <strong>{team.objective}</strong>
          <span>
            {members.length ? `${state} · ${copy.memberCount(members.length)}` : state}
          </span>
        </span>
        <span className="assistant-team-chevron" aria-hidden="true">
          ›
        </span>
      </summary>
      {team.ownerRequestQuote && (
        <p className="assistant-team-reason">
          {copy.team.startedBecause(team.ownerRequestQuote)}
        </p>
      )}
      {result && <p className="assistant-team-result">{result}</p>}
      <ul className="assistant-team-members">
        {members.map((m) => {
          const report = reports.get(m.id);
          const chat = {
            view: "agents",
            assistantId: m.assistantId,
            ...(m.conversationId
              ? { conversationId: m.conversationId }
              : { agentSettings: true }),
          };
          // Stored incomplete: the whole report is in the member's chat.
          const shortened = (
            <p className="assistant-note">
              {copy.team.reportShortened}{" "}
              <RouteLink route={chat} navigate={navigate}>
                {copy.team.openMemberChat}
              </RouteLink>
            </p>
          );
          return (
            <li key={m.id}>
              <button
                type="button"
                className="assistant-team-member"
                onClick={() => navigate(chat)}
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
              {report &&
                (report.reportAvailable || report.text?.trim() ? (
                  <TeamReport teamId={team.id} report={report} shortened={shortened} />
                ) : report.cut ? (
                  shortened
                ) : (
                  <p className="assistant-team-report-missing">{copy.team.noReport}</p>
                ))}
            </li>
          );
        })}
      </ul>
      <TeamCodingRequests actions={coding} busy={busy} onDecide={onDecideCoding} />
      <div className="assistant-card-actions">
        {team.parentConversationId && (
          <RouteLink
            className="button secondary"
            route={{
              view: "agents",
              assistantId: team.parentAssistantId,
              teamId: team.id,
            }}
            navigate={navigate}
          >
            {copy.team.showInChat}
          </RouteLink>
        )}
        {!finished.includes(team.phase) && (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => act(() => assistantApi.teamAction("teams", team.id, "stop"))}
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
    </details>
  );
}
