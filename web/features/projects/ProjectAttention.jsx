import React from "react";
import Icon from "../../components/Icon.jsx";
import { projectsHubCopy as copy } from "../../lib/i18n/messages/projects.js";
import { attentionTarget, hintCount } from "./project-presentation.js";

// Waiting decisions and failed runs on top of the overview: one known run opens
// directly, several open the project's run list with the matching filter.
export default function ProjectAttention({ projectId, attention, onNavigate }) {
  const items = [
    { kind: "decisions", status: "awaiting-human", text: copy.decisions },
    { kind: "failed", status: "failed", text: copy.failedRuns },
  ].filter((item) => attention?.[item.kind]?.count > 0);
  if (!items.length) return null;
  return (
    <div className="project-attention">
      {items.map(({ kind, status, text }) => {
        const part = attention[kind];
        return (
          <button
            key={kind}
            type="button"
            className={`project-attention-strip ${kind}`}
            onClick={() => onNavigate(attentionTarget(projectId, status, part))}
          >
            <span className="dot" aria-hidden="true" />
            <span className="project-attention-text">
              {text(hintCount(part.count, part.capped))}
            </span>
            <Icon name="chevron" size={14} />
          </button>
        );
      })}
    </div>
  );
}
