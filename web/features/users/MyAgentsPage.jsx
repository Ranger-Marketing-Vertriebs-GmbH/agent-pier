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
import { RowMenu, useRowMenu } from "../extensions/RowMenu.jsx";
import useMediaQuery from "../../lib/useMediaQuery.js";
import { agentGroupsCopy } from "../../lib/i18n/messages/agent-groups.js";
import { sortByOrder } from "../assistants/order/agent-order.js";
import useAgentOrdering, {
  orderRowClass,
  useShownOrder,
} from "../assistants/order/useAgentOrdering.jsx";

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

// One agent of her list: a tap opens it; a long press or a mouse drags it into a new
// place, and its ⋯ menu moves it up or down (useAgentOrdering.jsx).
function AgentEntry({ agent, ordering, finePointer, ...row }) {
  const menu = useRowMenu();
  const up = ordering.up(agent.id),
    down = ordering.down(agent.id);
  const label = agentGroupsCopy.actions(agent.name);
  const items = [
    ...(up ? [{ id: "up", label: agentGroupsCopy.up, run: up }] : []),
    ...(down ? [{ id: "down", label: agentGroupsCopy.down, run: down }] : []),
  ];
  return (
    <div
      {...ordering.rowProps(agent.id, { section: "all", kind: "own" })}
      {...(finePointer && ordering.dragProps(agent.id))}
      className={["user-agent-entry", orderRowClass(ordering.drag, agent.id)]
        .filter(Boolean)
        .join(" ")}
    >
      <ListRow
        {...row}
        menu={
          items.length ? { label, expanded: menu.open, onClick: menu.toggle } : undefined
        }
      />
      {items.length > 0 && <RowMenu label={label} state={menu} items={items} />}
    </div>
  );
}

/**
 * The user's start page: one row per agent she may use (own or shared), with its
 * activity, in her own order (server agent-order.js); a tap opens her main chat with
 * it. `refresh()` reads her list again after she reordered it.
 */
export default function MyAgentsPage({ agents: listed, error, navigate, refresh }) {
  const [opening, setOpening] = useState(null);
  const [failure, setFailure] = useState("");
  const finePointer = useMediaQuery("(pointer: fine)");
  const shownOrder = useShownOrder(null);
  const agents =
    listed && shownOrder.order ? sortByOrder(listed, shownOrder.order) : listed;
  const ordering = useAgentOrdering({
    display: (agents || []).map((agent) => ({
      id: agent.id,
      name: agent.name,
      section: "all",
      kind: "own",
    })),
    shown: shownOrder,
    enabled: (agents?.length ?? 0) > 1,
    save: async (ids) => {
      await userApi.saveOrder(ids);
      await refresh?.();
    },
  });
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
      <ErrorMessage error={failure || ordering.error || error} />
      {ordering.status}
      {agents === null ? (
        <p role="status">{copy.loading}</p>
      ) : agents.length ? (
        <section className="user-agents">
          <GroupLabel id="user-agents-label">{copy.yourAgents}</GroupLabel>
          <ListCard labelledBy="user-agents-label">
            <div
              {...ordering.listProps}
              className="user-agents-order"
              data-order-section="all"
            >
              {agents.map((agent) => (
                <AgentEntry
                  key={agent.id}
                  agent={agent}
                  ordering={ordering}
                  finePointer={finePointer}
                  icon={<AgentAvatar agent={agent} />}
                  label={agent.name}
                  sub={opening === agent.id ? copy.opening : agentActivity(agent)}
                  value={agent.shared ? copy.sharedBadge : undefined}
                  disabled={opening === agent.id}
                  onClick={() => open(agent)}
                />
              ))}
            </div>
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
