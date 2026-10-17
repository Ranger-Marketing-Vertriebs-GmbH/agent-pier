import React from "react";
import Icon from "../../components/Icon.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { mcpServerCopy as mcpCopy } from "../../lib/i18n/messages/mcp-servers.js";
import "../mcp-servers/mcp-servers.css";
import { assistantApi } from "./assistant-api.js";
import { avatarGlyph } from "./avatar-glyph.js";
import { grantsLine, holdsShellSsh } from "./member-grants.js";
import { memberGrantCopy as grantCopy } from "../../lib/i18n/messages/assistant-member-grants.js";

// A team proposal waiting for the owner: its members, what the lead grants each
// (shell and SSH highlighted), their MCP servers and the decision. Shown in the lead's chat until decided, and in the Work tab's team list.
export default function TeamProposalCard({ team, busy, act }) {
  // An unreadable MCP server list blocks the approval until it can be read.
  const unavailable = team.members.some((m) => m.mcpServersUnavailable);
  const decide = (decision) =>
    act(() =>
      assistantApi.decideTeam(team.id, {
        revision: team.revision,
        decision,
        ...(decision === "approve" ? { lifetime: "task" } : {}),
      }),
    );
  return (
    <article
      id={`assistant-team-${team.id}`}
      data-pending=""
      tabIndex={-1}
      className="assistant-team-card awaiting"
      aria-label={team.objective}
    >
      <div className="assistant-team-head">
        <span className="assistant-team-icon" aria-hidden="true">
          <Icon name="users" size={15} />
        </span>
        <span className="assistant-team-title">
          <strong>{team.objective}</strong>
          <span>{copy.team.states.awaiting_approval}</span>
        </span>
      </div>
      {team.ownerRequestQuote && (
        <p className="assistant-team-reason">
          {copy.team.startedBecause(team.ownerRequestQuote)}
        </p>
      )}
      <p className="assistant-team-hint">{copy.team.approvalHint}</p>
      {team.members.some((m) => holdsShellSsh(m.grants)) && (
        <p className="mcp-team-warning notice" data-member-shell-ssh="">
          {grantCopy.proposalWarning}
        </p>
      )}
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
              <small
                className="assistant-team-grants"
                data-grants=""
                {...(holdsShellSsh(m.grants) ? { "data-shell-ssh": "" } : {})}
              >
                {holdsShellSsh(m.grants) && "⚠ "}
                {grantsLine(m.grants)}
              </small>
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
          onClick={() => decide("approve")}
        >
          {copy.team.approve}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => decide("decline")}
        >
          {copy.team.decline}
        </button>
      </div>
    </article>
  );
}
