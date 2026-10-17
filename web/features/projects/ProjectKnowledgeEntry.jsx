import React from "react";
import Icon from "../../components/Icon.jsx";
import { memoryCopy as copy } from "../../lib/i18n/messages/memory.js";
import { entryAuthor } from "../memory/memory-presentation.js";
import { relativeTime } from "./ProjectOverview.jsx";

// One knowledge entry: clicking the row or its title shows the full text and actions.
export default function ProjectKnowledgeEntry({
  entry,
  open,
  onToggle,
  busy,
  onEdit,
  onHistory,
  onArchive,
  onForget,
}) {
  const bodyId = `project-knowledge-body-${entry.id}`;
  const stopAnd = (run) => (event) => {
    event.stopPropagation();
    run();
  };
  return (
    <article className="project-knowledge-entry" onClick={onToggle}>
      <div className="project-knowledge-entry-head">
        <button
          type="button"
          className="project-knowledge-entry-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={stopAnd(onToggle)}
        >
          <Icon name="chevron" size={14} className="project-knowledge-entry-chevron" />
          {entry.title}
        </button>
        <span className="project-knowledge-entry-time">
          {relativeTime(entry.updatedAt)}
        </span>
      </div>
      <div id={bodyId} className="project-knowledge-entry-body">
        <p className={open ? "expanded" : ""}>{entry.content}</p>
        <span className="project-knowledge-entry-meta">
          {entryAuthor(entry)} · {copy.version(entry.revision)}
        </span>
      </div>
      {open && (
        <div className="project-knowledge-entry-actions">
          {!entry.archived && (
            <button
              type="button"
              className="button secondary compact"
              aria-label={copy.edit(entry.title)}
              onClick={stopAnd(onEdit)}
            >
              {copy.editEntry}
            </button>
          )}
          <button
            type="button"
            className="button secondary compact"
            aria-label={copy.history(entry.title)}
            onClick={stopAnd(onHistory)}
          >
            {copy.historyTitle}
          </button>
          <button
            type="button"
            className="button secondary compact"
            aria-label={
              entry.archived ? copy.restore(entry.title) : copy.archive(entry.title)
            }
            disabled={busy}
            onClick={stopAnd(onArchive)}
          >
            {entry.archived ? copy.active : copy.archived}
          </button>
          <button
            type="button"
            className="button danger compact"
            aria-label={copy.forget(entry.title)}
            disabled={busy}
            onClick={stopAnd(onForget)}
          >
            {copy.forgetAction}
          </button>
        </div>
      )}
    </article>
  );
}
