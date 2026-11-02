import { commonCopy } from "../../lib/i18n/messages/common.js";
import { taskPanelCopy as copy } from "../../lib/i18n/messages/chat.js";
import { usePane } from "../../lib/pane-context.js";
import SubagentList from "./SubagentList.jsx";
import React, { useEffect, useRef } from "react";
const taskLabels = {
  get pending() {
    return commonCopy.pendingTask;
  },
  get in_progress() {
    return commonCopy.taskInProgress;
  },
  get completed() {
    return commonCopy.completed;
  },
};
export default function Tasks({
  tasks,
  subagents = [],
  open,
  close,
  id,
  compact,
  active,
}) {
  const dialog = useRef(null);
  // In a split pane the drawer stays inside its pane: non-modal, so the other panes
  // keep working, and it closes on Escape and a press outside it itself.
  const modal = !usePane();
  const shown = compact && open && active;
  useEffect(() => {
    if (!compact || !dialog.current) return;
    const element = dialog.current;
    if (shown && !element.open) modal ? element.showModal() : element.show();
    else if (!shown && element.open) element.close();
    return () => {
      if (element.open) element.close();
    };
  }, [compact, shown, modal]);
  const dismiss = () => {
    // Remove modal inertness before returning focus to the explicit opener.
    if (dialog.current?.open) dialog.current.close();
    close();
  };
  const latestDismiss = useRef(dismiss);
  latestDismiss.current = dismiss;
  useEffect(() => {
    if (modal || !shown) return;
    const pressOutside = (event) => {
      const target = event.target;
      if (dialog.current?.contains(target)) return;
      // The toggle closes it itself; closing here as well would reopen it.
      if (target.closest?.("[aria-controls]")?.getAttribute("aria-controls") === id)
        return;
      latestDismiss.current();
    };
    document.addEventListener("pointerdown", pressOutside, true);
    return () => document.removeEventListener("pointerdown", pressOutside, true);
  }, [modal, shown, id]);
  const completed = tasks.filter((task) => task.status === "completed").length;
  const content = (
    <>
      <div className="task-heading">
        <strong>{commonCopy.tasks}</strong>
        <span className="task-count">
          {completed}/{tasks.length}
        </span>
        <button type="button" aria-label={copy.taskHeadingAriaLabel} onClick={dismiss}>
          ×
        </button>
      </div>
      {tasks.length ? (
        <>
          <progress
            aria-label={copy.contentAriaLabel}
            max={tasks.length}
            value={completed}
          />
          <ol>
            {tasks.map((task) => (
              <li key={task.id} className={`task-${task.status}`}>
                <span className="task-symbol" aria-hidden="true">
                  {task.status === "completed"
                    ? "✓"
                    : task.status === "in_progress"
                      ? "◉"
                      : "○"}
                </span>
                <div>
                  <span>{task.text}</span>
                  <small>{taskLabels[task.status] || commonCopy.pendingTask}</small>
                </div>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="tasks-empty">{copy.tasksEmpty}</p>
      )}
      <SubagentList subagents={subagents} />
    </>
  );
  return compact ? (
    <dialog
      ref={dialog}
      id={id}
      className="chat-tasks task-drawer"
      aria-label={commonCopy.taskList}
      // Non-modal: focusable itself, so a click on its text keeps Escape working.
      tabIndex={modal ? undefined : -1}
      onKeyDown={(event) => {
        if (modal || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          dismiss();
      }}
    >
      {content}
    </dialog>
  ) : (
    <aside id={id} className="chat-tasks" aria-label={commonCopy.taskList} hidden={!open}>
      {content}
    </aside>
  );
}
