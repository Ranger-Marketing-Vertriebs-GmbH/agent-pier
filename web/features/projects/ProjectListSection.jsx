import React, { useId } from "react";
import Icon from "../../components/Icon.jsx";
import { projectGroupsCopy as copy } from "../../lib/i18n/messages/project-groups.js";

/**
 * One section of the projects list (a group, "No group", an origin owner or "Local
 * only"): a sticky header button that opens and closes it, then its rows. A section
 * without `title` (the flat list) shows its rows without a header.
 */
export default function ProjectListSection({ section, title, open, onToggle, children }) {
  const id = useId();
  if (!title) return <div className="project-section-rows">{children}</div>;
  return (
    <section className={`project-section ${section.kind}`} data-section={section.key}>
      <div className="project-section-header">
        <button
          type="button"
          className="project-section-toggle"
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
        >
          <Icon name="chevron" size={14} className="project-section-chevron" />
          <Icon name="folder" size={16} className="project-section-icon" />
          <span className="project-section-title">{title}</span>
          <span className="project-section-count">{section.count}</span>
        </button>
      </div>
      <div className="project-section-rows" id={id} hidden={!open}>
        {section.kind === "group" && !section.count ? (
          <p className="project-section-empty">{copy.emptyGroup}</p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
