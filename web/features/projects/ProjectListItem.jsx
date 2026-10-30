import React from "react";
import StatusDot from "../../components/StatusDot.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { projectGroupsCopy as groupsCopy } from "../../lib/i18n/messages/project-groups.js";
import { projectsHubCopy as copy } from "../../lib/i18n/messages/projects.js";
import ProjectMenuButton from "./ProjectMenuButton.jsx";
import { hintCount, remoteShort } from "./project-presentation.js";

// A project row: name over `owner/repo` or "Local only", attention hints, "● Running"
// while a session runs, and the ⋯ menu beside the row's own button (`menuSheet` turns
// it into a sheet on phones; none without `menuItems`). On desktop the row's button also starts a drag
// (`onPress`, useProjectDrag.js).
export default function ProjectListItem({
  item,
  attention,
  running,
  selected,
  onSelect,
  onPress,
  dragging = false,
  menuItems,
  menuSheet = null,
}) {
  const { decisions, failed } = attention;
  return (
    <div
      className={`project-row ${selected ? "selected" : ""} ${dragging ? "dragging" : ""}`}
    >
      <button
        type="button"
        className="project-row-main"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(item.id)}
        onPointerDown={onPress}
      >
        <span className="project-item-text">
          <strong>{item.name}</strong>
          <small>{item.remote ? remoteShort(item.remote) : copy.localOnly}</small>
          {decisions.count > 0 && (
            <small className="project-hint decision">
              {copy.decisions(hintCount(decisions.count, decisions.capped))}
            </small>
          )}
          {failed.count > 0 && (
            <small className="project-hint failed">
              {copy.failedRuns(hintCount(failed.count, failed.capped))}
            </small>
          )}
        </span>
        {running && (
          <span className="project-row-status">
            <StatusDot tone="ok" />
            {commonCopy.running}
          </span>
        )}
      </button>
      {menuItems && (
        <ProjectMenuButton
          className="project-row-more"
          data-project-path={item.path}
          label={groupsCopy.projectActions(item.name)}
          items={menuItems}
          sheet={menuSheet}
        />
      )}
    </div>
  );
}
