import React, { useEffect, useRef, useState } from "react";
import { assistantApi } from "./assistant-api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import SidebarGroup from "../../app/SidebarGroup.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import useAssistants from "./useAssistants.js";
import { avatarGlyph } from "./avatar-glyph.js";
import { connectionMissing } from "./connection-state.js";
export default function AssistantSidebar({ navigate, route }) {
  const {
    assistants,
    conversations,
    members = [],
    teams = [],
    models = [],
    runtime,
    refresh,
  } = useAssistants();
  const [opening, setOpening] = useState(null),
    [error, setError] = useState(""),
    [expanded, setExpanded] = useState(() => new Set());
  const request = useRef(null);
  useEffect(
    () => () => {
      request.current = null;
    },
    [route],
  );
  async function open(assistant, chat) {
    const ticket = {};
    request.current = ticket;
    setError("");
    if (chat) {
      navigate({ view: "agents", assistantId: assistant.id, conversationId: chat.id });
      return;
    }
    // Settings explain a missing connection and offer the model choice.
    if (assistant.teamMemberId || connectionMissing(assistant, models)) {
      navigate({ view: "agents", assistantId: assistant.id, agentSettings: true });
      return;
    }
    setOpening(assistant.id);
    try {
      const conversation = await assistantApi.open(assistant.id);
      await refresh();
      if (request.current === ticket)
        navigate({
          view: "agents",
          assistantId: assistant.id,
          conversationId: conversation.id,
        });
    } catch (error) {
      if (request.current === ticket) setError(error.message);
    } finally {
      setOpening(null);
    }
  }
  const roots = assistants.filter(
    (a) => !a.archivedAt && (!a.teamMemberId || a.lifetime === "permanent"),
  );
  const selectedMember = (parent) =>
    assistants.some(
      (child) => child.parentAssistantId === parent.id && child.id === route.assistantId,
    );
  const folded = (parent) => !expanded.has(parent.id) && !selectedMember(parent);
  const toggle = (id) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const visible = roots.flatMap((a) => [
    a,
    ...assistants.filter(
      (child) =>
        child.parentAssistantId === a.id &&
        child.lifetime === "task" &&
        !child.archivedAt,
    ),
  ]);
  function item(assistant) {
    const member = members.find((m) => m.assistantId === assistant.id);
    const chat = conversations.find(
      (c) =>
        c.assistantId === assistant.id &&
        !c.archivedAt &&
        (!c.channel || c.channel === "agentpier"),
    );
    const detail =
      opening === assistant.id
        ? copy.loading
        : member
          ? `${member.role} · ${copy.team.states[member.phase]}`
          : assistant.model.modelId;
    return (
      <button
        key={assistant.id}
        className={`session-item assistant-sidebar-item ${assistant.teamMemberId && assistant.lifetime === "task" ? "assistant-sidebar-member" : ""} ${route.assistantId === assistant.id && route.view === "agents" ? "selected" : ""}`}
        aria-label={copy.sidebarLabel(
          assistant.name,
          member ? member.role : assistant.model.modelId,
          member
            ? copy.team.states[member.phase]
            : connectionMissing(assistant, models)
              ? copy.status.connectionMissing
              : copy.status[runtime.availability],
        )}
        aria-describedby={member ? `assistant-task-${assistant.id}` : undefined}
        aria-current={
          route.assistantId === assistant.id && route.view === "agents"
            ? "page"
            : undefined
        }
        disabled={!!opening && !chat && !member}
        onClick={() => open(assistant, chat)}
      >
        <span className="assistant-avatar" aria-hidden="true">
          {avatarGlyph(assistant.name)}
        </span>
        <span>
          <strong>{assistant.name}</strong>
          <small>{detail}</small>
          {member && (
            <small
              id={`assistant-task-${assistant.id}`}
              className="assistant-sidebar-task"
              title={member.assignment}
            >
              {member.assignment}
            </small>
          )}
        </span>
      </button>
    );
  }
  if (!roots.length) return null;
  return (
    <SidebarGroup
      name="assistant-chats"
      label={copy.chats}
      count={String(roots.length)}
      defaultOpen
      activeKey={route.assistantId}
    >
      <ErrorMessage error={error} />
      <div className="session-list">
        {roots.map((parent) => {
          const groups = new Map();
          for (const child of visible.filter(
            (a) => a.parentAssistantId === parent.id && a.lifetime === "task",
          )) {
            const member = members.find((m) => m.assistantId === child.id);
            const id = member?.teamId || child.teamId;
            if (!groups.has(id)) groups.set(id, []);
            groups.get(id).push(child);
          }
          const memberCount = [...groups.values()].reduce((n, c) => n + c.length, 0);
          const hidden = folded(parent);
          return (
            <React.Fragment key={parent.id}>
              {item(parent)}
              {memberCount > 0 && !selectedMember(parent) && (
                <button
                  className="assistant-sidebar-toggle"
                  aria-expanded={!hidden}
                  onClick={() => toggle(parent.id)}
                >
                  {hidden ? copy.showMembers(memberCount) : copy.hideMembers(memberCount)}
                </button>
              )}
              {!hidden &&
                [...groups].reverse().map(([id, children]) => {
                  const team = teams.find((t) => t.id === id);
                  const label = team?.objective || copy.team.title;
                  return (
                    <div
                      className="assistant-sidebar-team"
                      role="group"
                      aria-label={label}
                      key={id || "members"}
                    >
                      <div className="assistant-sidebar-assignment">
                        <strong title={label}>{label}</strong>
                        {team && (
                          <small>{copy.team.states[team.status || team.phase]}</small>
                        )}
                      </div>
                      {children.map(item)}
                    </div>
                  );
                })}
            </React.Fragment>
          );
        })}
      </div>
    </SidebarGroup>
  );
}
