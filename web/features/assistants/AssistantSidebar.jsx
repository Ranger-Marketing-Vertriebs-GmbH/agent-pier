import React, { useEffect, useRef, useState } from "react";
import { assistantApi } from "./assistant-api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import SidebarGroup from "../../app/SidebarGroup.jsx";
import { agentsHubCopy } from "../../lib/i18n/messages/agents-hub.js";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { leadRequestCopy } from "../../lib/i18n/messages/lead-requests.js";
import useAssistants from "./useAssistants.js";
import { avatarGlyph } from "./avatar-glyph.js";
import { connectionMissing } from "./connection-state.js";
import { serviceDown } from "./hub/hub-model.js";
import Icon from "../../components/Icon.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import { activityTone } from "../../components/status-tones.js";
import { activityFor, activityDot, sidebarSubline } from "./assistant-status.js";
import SidebarChats from "./chats/SidebarChats.jsx";
import { usersCopy } from "../../lib/i18n/messages/users.js";

// Agents whose team members the owner unfolded stay unfolded across reloads (per
// browser, like the sidebar groups). Storage may be unavailable; folding still works.
const expandedKey = "agentpier.sidebar.agents.expanded";
function readExpanded() {
  try {
    const saved = JSON.parse(localStorage.getItem(expandedKey) || "[]");
    return new Set(
      Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [],
    );
  } catch {
    return new Set();
  }
}
function saveExpanded(ids) {
  try {
    localStorage.setItem(expandedKey, JSON.stringify([...ids]));
  } catch {}
}

export default function AssistantSidebar({ navigate, route }) {
  const {
    assistants,
    conversations,
    members = [],
    teams = [],
    models = [],
    runtime,
    activity = {},
    loaded = false,
    connected,
    offline,
    refresh,
  } = useAssistants();
  // Without a connection the rows show the last known state until it is back.
  const stale = offline || !connected;
  // A stopped or failed agent service (handoff 5.10): rows dimmed with "offline" and
  // a warning dot on the group head; the hub shows the banner with start and diagnose.
  const down = serviceDown(runtime);
  const [opening, setOpening] = useState(null),
    [error, setError] = useState(""),
    [expanded, setExpanded] = useState(readExpanded);
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
    // Settings explain a missing connection and offer the model choice. A user's own
    // agent is hers to chat with: the owner manages it in its settings.
    if (
      assistant.teamMemberId ||
      connectionMissing(assistant, models) ||
      assistant.userAccess?.mode === "own"
    ) {
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
  // A member kept as a permanent agent stays under the lead that created it; only
  // when that lead is archived (or gone) does it become a root agent of its own.
  const leads = new Map(assistants.map((a) => [a.id, a]));
  const leadGone = (a) => {
    const lead = leads.get(a.parentAssistantId);
    return !lead || !!lead.archivedAt;
  };
  // The owner's agents first, then the agents of users under their own heading.
  const roots = assistants
    .filter(
      (a) =>
        !a.archivedAt && (!a.teamMemberId || (a.lifetime === "permanent" && leadGone(a))),
    )
    .sort((a, b) => Boolean(a.userAccess) - Boolean(b.userAccess));
  const permanentOf = (parent) =>
    parent.teamMemberId
      ? []
      : assistants.filter(
          (child) =>
            child.parentAssistantId === parent.id &&
            child.teamMemberId &&
            child.lifetime === "permanent" &&
            !child.archivedAt,
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
      saveExpanded(next);
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
  const quiet = (phase) =>
    ["ready", "completed", "failed", "cancelled", "declined", "partial"].includes(phase);
  // The owner's own open chats with an agent, his main chat first, then the most
  // recently active; a user's chat (readable under her opt-in) is not his to open here.
  const chatsOf = (assistant) =>
    conversations
      .filter(
        (c) =>
          c.assistantId === assistant.id &&
          !c.archivedAt &&
          (!c.channel || c.channel === "agentpier") &&
          (assistant.userAccess?.mode === "own" || typeof c.userId !== "string"),
      )
      .sort(
        (a, b) =>
          (b.main === true) - (a.main === true) ||
          String(b.lastActivityAt || b.createdAt).localeCompare(
            String(a.lastActivityAt || a.createdAt),
          ),
      );
  function item(assistant, nested = false) {
    const member = members.find((m) => m.assistantId === assistant.id);
    const chat = chatsOf(assistant)[0];
    const entry = activityFor(activity, assistant.id);
    const dot = activityDot(entry);
    const subline = down
      ? { text: copy.sidebarServiceOffline, tone: "meta" }
      : sidebarSubline({
          assistant,
          entry,
          member,
          model: assistant.model,
          copy,
        });
    const current = route.assistantId === assistant.id && route.view === "agents";
    return (
      <button
        key={assistant.id}
        className={`session-item assistant-sidebar-item ${nested ? "assistant-sidebar-member" : ""} ${current ? "selected" : ""}`}
        aria-label={copy.sidebarLabel(
          assistant.name,
          member
            ? `${member.role} · ${assistant.model.modelId}`
            : assistant.model.modelId,
          member
            ? copy.team.states[member.phase]
            : connectionMissing(assistant, models)
              ? copy.status.connectionMissing
              : copy.status[runtime.availability],
        )}
        aria-describedby={member ? `assistant-task-${assistant.id}` : undefined}
        aria-current={current ? "page" : undefined}
        disabled={!!opening && !chat && !member}
        onClick={() => open(assistant, chat)}
      >
        <span className="assistant-avatar-wrap" aria-hidden="true">
          <span className="assistant-avatar">{avatarGlyph(assistant.name)}</span>
          {dot && (
            <StatusDot
              tone={activityTone(dot)}
              pulse={dot === "working"}
              className={`activity-dot ${dot}`}
            />
          )}
        </span>
        <span>
          <strong>{assistant.name}</strong>
          {opening === assistant.id ? (
            <small>{copy.loading}</small>
          ) : nested ? (
            <>
              <small className={subline.tone === "accent" ? "accent" : ""}>
                {subline.text}
              </small>
              {member && (
                <small
                  id={`assistant-task-${assistant.id}`}
                  className="assistant-sidebar-task"
                  title={member.assignment}
                >
                  {member.assignment}
                </small>
              )}
            </>
          ) : (
            <>
              <small className={subline.tone === "accent" ? "accent" : ""}>
                {member ? `${member.role} · ${subline.text}` : subline.text}
              </small>
              {member && (
                <small
                  id={`assistant-task-${assistant.id}`}
                  className="assistant-sidebar-task"
                  title={member.assignment}
                >
                  {member.assignment}
                </small>
              )}
            </>
          )}
        </span>
      </button>
    );
  }
  // Once the list is in, the group stays even without agents: its head "+" is the
  // sidebar's way to create the first one.
  if (!roots.length && !loaded) return null;
  return (
    <SidebarGroup
      name="assistant-chats"
      label={copy.agentsGroup}
      ariaLabel={copy.chats}
      count={String(roots.length)}
      defaultOpen
      activeKey={route.assistantId}
      warning={down ? agentsHubCopy.first.serviceDown : ""}
    >
      <ErrorMessage error={error} />
      {stale && (
        <p role="status" className="assistant-sidebar-offline">
          {copy.sidebarOffline}
        </p>
      )}
      <div
        className={`session-list${stale ? " assistant-sidebar-stale" : ""}${down ? " assistant-sidebar-down" : ""}`}
      >
        {!roots.length && <p className="assistant-sidebar-empty">{copy.empty}</p>}
        {roots.map((parent, index) => {
          const groups = new Map();
          for (const child of visible.filter(
            (a) => a.parentAssistantId === parent.id && a.lifetime === "task",
          )) {
            const member = members.find((m) => m.assistantId === child.id);
            const id = member?.teamId || child.teamId;
            if (!groups.has(id)) groups.set(id, []);
            groups.get(id).push(child);
          }
          const permanent = permanentOf(parent);
          const temporaryCount = [...groups.values()].reduce((n, c) => n + c.length, 0);
          const memberCount = temporaryCount + permanent.length;
          const hidden = folded(parent);
          const current = route.assistantId === parent.id && route.view === "agents";
          return (
            <React.Fragment key={parent.id}>
              {parent.userAccess && !roots[index - 1]?.userAccess && (
                <div className="assistant-sidebar-section">{usersCopy.agentsOfUsers}</div>
              )}
              <div className={`assistant-sidebar-row ${current ? "selected" : ""}`}>
                {item(parent)}
                {memberCount > 0 && (
                  <button
                    type="button"
                    className="assistant-team-pill"
                    aria-expanded={!hidden}
                    aria-label={
                      hidden
                        ? copy.showMembers(memberCount)
                        : copy.hideMembers(memberCount)
                    }
                    onClick={() => toggle(parent.id)}
                  >
                    <Icon name="users" size={12} strokeWidth="1.8" />
                    {memberCount}
                  </button>
                )}
              </div>
              {current && (
                <SidebarChats
                  chats={chatsOf(parent).slice(0, 4)}
                  currentId={route.conversationId}
                  onOpen={(chat) => open(parent, chat)}
                />
              )}
              {!hidden && permanent.length > 0 && (
                <>
                  <div className="assistant-sidebar-section" aria-hidden="true">
                    {leadRequestCopy.permanentSection}
                  </div>
                  <div
                    className="assistant-sidebar-team assistant-sidebar-permanent"
                    role="group"
                    aria-label={leadRequestCopy.permanentSection}
                  >
                    {permanent.map((child) => item(child, true))}
                  </div>
                </>
              )}
              {!hidden && temporaryCount > 0 && (
                <div className="assistant-sidebar-section">
                  {leadRequestCopy.temporarySection}
                </div>
              )}
              {!hidden &&
                [...groups].reverse().map(([id, children]) => {
                  const team = teams.find((t) => t.id === id);
                  const label = team?.objective || copy.team.title;
                  const state = team && (team.status || team.phase);
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
                          <small className={quiet(state) ? "" : "accent"}>
                            {copy.team.states[state]}
                          </small>
                        )}
                      </div>
                      {children.map((child) => item(child, true))}
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
