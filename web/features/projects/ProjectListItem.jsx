import React from "react";
import Icon from "../../components/Icon.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { projectGroupsCopy as groupsCopy } from "../../lib/i18n/messages/project-groups.js";
import { projectsHubCopy as copy } from "../../lib/i18n/messages/projects.js";
import { RowMenu, useRowMenu } from "../extensions/RowMenu.jsx";
import { hintCount, remoteShort } from "./project-presentation.js";

// A project row: name over `owner/repo` or "Local only", attention hints, "● Running"
// while a session runs, and the ⋯ menu beside the row's own button.
export default function ProjectListItem({
  item,
  attention,
  running,
  selected,
  onSelect,
  menuItems,
}) {
  const menu = useRowMenu();
  const { decisions, failed } = attention;
  const label = groupsCopy.projectActions(item.name);
  return (
    <div className={`project-row ${selected ? "selected" : ""}`}>
      <button
        type="button"
        className="project-row-main"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(item.id)}
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
        <Icon name="chevron" size={16} className="project-item-chevron" />
      </button>
      <button
        type="button"
        className="icon-button project-row-more"
        data-project-path={item.path}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
      >
        <Icon name="more" size={18} />
      </button>
      <RowMenu label={label} state={menu} items={menuItems} />
    </div>
  );
}
