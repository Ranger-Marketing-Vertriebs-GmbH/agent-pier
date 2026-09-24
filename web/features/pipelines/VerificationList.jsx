import React from "react";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";

// Registered projects; only the opened project, whose steps are loaded, shows its
// step count, so the list costs no request per project.
export default function VerificationList({ projects, selectedId, stepCount, onSelect }) {
  return (
    <div className="list-detail-items verification-list">
      {projects.map((project) => {
        const selected = project.id === selectedId;
        return (
          <button
            type="button"
            key={project.id}
            className={`verification-item${selected ? " selected" : ""}`}
            aria-current={selected ? "true" : undefined}
            title={project.cwd}
            onClick={() => onSelect(project.id)}
          >
            <strong>{project.name}</strong>
            <small>{project.cwd}</small>
            {selected && typeof stepCount === "number" && (
              <small className="verification-item-count">
                {copy.stepCount(stepCount)}
              </small>
            )}
          </button>
        );
      })}
    </div>
  );
}
