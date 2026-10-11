import React from "react";
import ProviderMark from "../components/ProviderMark.jsx";
import { sessionActivity, sandboxBadge } from "./SidebarGroup.jsx";

// Sessions may lack a working directory (cwd null); they then show no location.
const folder = (cwd) => (cwd ? cwd.split("/").filter(Boolean).at(-1) || cwd : "");

// The provider mark names the tool, so the subline only carries state and location.
export default function SessionRow({ session, selected, onSelect, names }) {
  const activity = sessionActivity(session);
  const shell = session.tool === "shell";
  const location = shell ? "" : session.repositoryName || folder(session.cwd);
  return (
    <button
      className={`session-item ${selected ? "selected" : ""}`}
      onClick={() => onSelect(session)}
      title={session.cwd}
    >
      <span className="session-provider">
        <ProviderMark
          tool={session.tool}
          size="row"
          label={shell ? undefined : names[session.tool]}
        />
        <span className={`activity-dot ${activity.state}`} aria-hidden="true" />
      </span>
      <span>
        <strong>{session.name}</strong>
        <small>
          <span className={`activity-label ${activity.state}`}>{activity.label}</span>
          {location && ` · ${location}`}
          {session.sandbox && ` · ${sandboxBadge(session)}`}
        </small>
      </span>
    </button>
  );
}
