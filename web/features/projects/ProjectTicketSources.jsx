import React, { useState } from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { projectTicketsCopy as copy } from "../../lib/i18n/messages/tickets.js";
import PlaneLinkDialog from "./PlaneLinkDialog.jsx";

function githubSub(github) {
  if (github?.state !== "connected") return copy.githubNotConnected;
  return copy.githubConnected(
    github.repo,
    github.credential?.name,
    github.inProgressLabel,
  );
}

function planeSub(plane) {
  if (!plane?.planeProjectId) return copy.planeNotConnected;
  if (plane.state !== "connected")
    return copy.planeUnavailable(plane.identifier, plane.name);
  return copy.planeConnected(plane.identifier, plane.name, plane.connectionName);
}

/**
 * The ticket sources of a project: its GitHub repository (from the folder's remote and
 * the GitHub connection of its host) and its linked Plane project. Edit opens the link
 * dialog; the view comes from the `tickets.project` topic.
 */
export default function ProjectTicketSources({ view, projectId, onNavigate }) {
  const [editing, setEditing] = useState(false);
  const sources = view?.sources;
  return (
    <section className="project-ticket-sources" aria-labelledby="ticket-sources-heading">
      <GroupLabel
        id="ticket-sources-heading"
        action={{ label: copy.edit, onClick: () => setEditing(true), disabled: !view }}
      >
        {copy.sources}
      </GroupLabel>
      <ListCard labelledBy="ticket-sources-heading">
        <ListRow label={copy.github} sub={githubSub(sources?.github)} />
        <ListRow label={copy.plane} sub={planeSub(sources?.plane)} />
      </ListCard>
      {editing && (
        <PlaneLinkDialog
          projectId={projectId}
          view={view}
          onNavigate={onNavigate}
          close={() => setEditing(false)}
        />
      )}
    </section>
  );
}
