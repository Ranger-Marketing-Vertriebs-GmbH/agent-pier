import React from "react";
import ProviderMark from "../components/ProviderMark.jsx";
import StatusDot from "../components/StatusDot.jsx";
import { activityTone } from "../components/status-tones.js";
import { sessionListCopy } from "../lib/i18n/messages/sessions.js";
import { viewsCopy } from "../lib/i18n/messages/views.js";
import { writePayload } from "../features/views/drag-payload.js";
import { sessionActivity, sandboxBadge } from "./SidebarGroup.jsx";

// Sessions may lack a working directory (cwd null); they then show no location.
const folder = (cwd) => (cwd ? cwd.split("/").filter(Boolean).at(-1) || cwd : "");

// The provider mark names the tool, so the subline only carries state and location.
// `draggable` (split views offered) lets the row be dragged into a view; `inView`
// marks a session the open view shows.
export default function SessionRow({
  session,
  selected,
  onSelect,
  names,
  draggable = false,
  inView = false,
}) {
  const activity = sessionActivity(session);
  const shell = session.tool === "shell";
  const location = shell ? "" : session.repositoryName || folder(session.cwd);
  return (
    <button
      className={`session-item ${selected ? "selected" : ""}${inView ? " in-view" : ""}`}
      onClick={() => onSelect(session)}
      draggable={draggable || undefined}
      onDragStart={
        draggable
          ? (event) =>
              writePayload(event.dataTransfer, {
                item: { kind: "session", id: session.id },
              })
          : undefined
      }
      title={session.cwd}
    >
      <span className="session-provider">
        <ProviderMark
          tool={session.tool}
          size="row"
          label={shell ? undefined : names[session.tool]}
        />
        <StatusDot
          tone={activityTone(activity.state)}
          pulse={activity.state === "working"}
          className={`activity-dot ${activity.state}`}
        />
      </span>
      <span>
        <strong>{session.name}</strong>
        <small>
          <span className={`activity-label ${activity.state}`}>{activity.label}</span>
          {location && ` · ${location}`}
          {session.startedBy?.kind === "agent" &&
            ` · ${sessionListCopy.agentBadge(session.startedBy.name)}`}
          {session.ticket?.key && ` · ${session.ticket.key}`}
          {session.sandbox && ` · ${sandboxBadge(session)}`}
        </small>
        {inView && <span className="visually-hidden">{viewsCopy.shownInView}</span>}
      </span>
    </button>
  );
}
