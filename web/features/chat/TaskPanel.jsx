import { commonCopy } from "../../lib/i18n/messages/common.js";
import { taskPanelCopy as copy } from "../../lib/i18n/messages/chat.js";
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
  useEffect(() => {
    if (!compact || !dialog.current) return;
    const element = dialog.current;
    if (open && active && !element.open) element.showModal();
    else if ((!open || !active) && element.open) element.close();
    return () => {
      if (element.open) element.close();
    };
  }, [compact, open, active]);
  const dismiss = () => {
    // Remove modal inertness before returning focus to the explicit opener.
    if (dialog.current?.open) dialog.current.close();
    close();
  };
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
