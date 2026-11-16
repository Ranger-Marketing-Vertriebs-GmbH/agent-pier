import React from "react";
import { backgroundTasksCopy as copy } from "../../lib/i18n/messages/chat.js";

const text = (line) =>
  line.kind === "running"
    ? copy.runningLine(line.count)
    : line.kind === "todos"
      ? copy.todosLine(line.done, line.total)
      : copy.title;

/** The line above the composer (`tasksLine`); it opens the background tasks sheet. */
export default function BackgroundTasksLine({ line, onOpen, buttonRef }) {
  if (!line) return null;
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`background-tasks-line${line.kind === "history" ? " muted" : ""}`}
      aria-haspopup="dialog"
      onClick={onOpen}
    >
      {text(line)}
    </button>
  );
}
