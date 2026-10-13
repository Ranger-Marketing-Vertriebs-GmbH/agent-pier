import React from "react";
import Icon from "../../components/Icon.jsx";
import { projectsHubCopy as copy } from "../../lib/i18n/messages/projects.js";
import { hintCount, remoteShort } from "./project-presentation.js";

// A project in the hub list: folder tile, name, remote or "local only", attention hints.
export default function ProjectListItem({ item, attention }) {
  const { decisions, failed } = attention;
  return (
    <>
      <span className="project-item-icon" aria-hidden="true">
        <Icon name="folder" size={16} />
      </span>
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
      <Icon name="chevron" size={16} className="project-item-chevron" />
    </>
  );
}
