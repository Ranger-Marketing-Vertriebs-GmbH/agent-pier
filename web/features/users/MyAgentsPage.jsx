import React, { useState } from "react";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { avatarGlyph } from "../assistants/avatar-glyph.js";
import { copyAt } from "../assistants/assistant-status.js";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { userAppCopy as copy } from "../../lib/i18n/messages/user-app.js";
import { userApi } from "./user-api.js";

/** What her agent does now: its activity, or Ready. */
export function agentActivity(agent) {
  const { state, label } = agent.activity || {};
  return (
    copyAt(assistantCopy, label) ||
    (state === "working" ? assistantCopy.status.running : assistantCopy.status.ready)
  );
}

/** Her agent's picture: the emoji or letter it carries, else its name's first one. */
export function AgentAvatar({ agent, className = "" }) {
  return (
    <span
      className={["assistant-avatar", "user-agent-avatar", className]
        .filter(Boolean)
        .join(" ")}
      aria-hidden="true"
    >
      {agent.avatar || avatarGlyph(agent.name)}
    </span>
  );
}

/**
 * The user's start page: one row per agent she may use (own or shared), with its
 * activity; a tap opens her main chat with it.
 */
export default function MyAgentsPage({ agents, error, navigate }) {
  const [opening, setOpening] = useState(null);
  const [failure, setFailure] = useState("");
  async function open(agent) {
    setFailure("");
    if (agent.conversationId)
      return navigate({
        view: "chat",
        agentId: agent.id,
        conversationId: agent.conversationId,
      });
    setOpening(agent.id);
    try {
      const chat = await userApi.open(agent.id);
      navigate({ view: "chat", agentId: agent.id, conversationId: chat.id });
    } catch (e) {
      setFailure(e.message);
    } finally {
      setOpening(null);
    }
  }
  return (
    <>
      <ErrorMessage error={failure || error} />
      {agents === null ? (
        <p role="status">{copy.loading}</p>
      ) : agents.length ? (
        <section className="user-agents">
          <GroupLabel id="user-agents-label">{copy.yourAgents}</GroupLabel>
          <ListCard labelledBy="user-agents-label">
            {agents.map((agent) => (
              <ListRow
                key={agent.id}
                icon={<AgentAvatar agent={agent} />}
                label={agent.name}
                sub={opening === agent.id ? copy.opening : agentActivity(agent)}
                value={agent.shared ? copy.sharedBadge : undefined}
                disabled={opening === agent.id}
                onClick={() => open(agent)}
              />
            ))}
          </ListCard>
        </section>
      ) : (
        <section className="user-app-empty">
          <p>{copy.empty}</p>
          <p className="user-app-hint">{copy.emptyHint}</p>
        </section>
      )}
      <p className="user-app-hint">{copy.scope}</p>
    </>
  );
}
