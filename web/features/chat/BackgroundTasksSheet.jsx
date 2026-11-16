import React, { useState } from "react";
import ListCard from "../../components/ListCard.jsx";
import Modal from "../../components/Modal.jsx";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { backgroundTasksCopy as copy } from "../../lib/i18n/messages/chat.js";
import { chatObservabilityCopy } from "../../lib/i18n/messages/chat-observability.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { completedStartsOpen } from "./background-tasks.js";
import { subagentStatus, subagentStatusLabel } from "./subagent-presentation.js";
import { usageSummary } from "./token-presentation.js";

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
const taskSymbols = { completed: "✓", in_progress: "◉" };

function Group({ id, label, count, open, children }) {
  return (
    <details className="background-tasks-group" data-group={id} open={open}>
      <summary>
        {label}
        {count !== undefined && <span className="background-tasks-count"> {count}</span>}
      </summary>
      {children}
    </details>
  );
}

function Agents({ agents, label, timed = false }) {
  return (
    <ListCard label={label}>
      {agents.map((agent) => {
        const usage = usageSummary(agent.usage);
        return (
          <article className="subagent-entry" key={agent.id}>
            <strong>{agent.name || agent.id}</strong>
            <p>{agent.task || chatObservabilityCopy.noTask}</p>
            <div className="subagent-meta">
              <span>{copy.kindAgent}</span>
              <small className={`subagent-status ${subagentStatus(agent)}`}>
                {subagentStatusLabel(agent.status)}
              </small>
              {timed && agent.updatedAt && (
                <time dateTime={agent.updatedAt}>{formatTimestamp(agent.updatedAt)}</time>
              )}
              {usage && <small className="subagent-usage">{usage}</small>}
            </div>
          </article>
        );
      })}
    </ListCard>
  );
}

/**
 * The sheet behind the line above the composer: working subagents, finished ones
 * and the CLI's to-dos, each in a group that can be folded. A bottom sheet on
 * phones, a centred dialog on desktop (`Modal`).
 */
export default function BackgroundTasksSheet({
  running = [],
  finished = [],
  tasks = [],
  close,
}) {
  // Decided once per opening, so a new completion never folds or unfolds the group.
  const [completedOpen] = useState(() => completedStartsOpen(finished));
  const done = tasks.filter((task) => task.status === "completed").length;
  return (
    <Modal
      title={copy.title}
      close={close}
      footer={null}
      className="background-tasks"
      dismissOnBackdrop
    >
      {running.length > 0 && (
        <Group id="running" label={copy.running} open>
          <Agents agents={running} label={copy.running} timed />
        </Group>
      )}
      {finished.length > 0 && (
        <Group
          id="completed"
          label={copy.completed}
          count={finished.length}
          open={completedOpen}
        >
          <Agents agents={finished} label={copy.completed} />
        </Group>
      )}
      {tasks.length > 0 && (
        <Group id="todos" label={copy.todos} count={`${done}/${tasks.length}`} open>
          <progress aria-label={copy.progress} max={tasks.length} value={done} />
          <ol className="background-tasks-todos">
            {tasks.map((task) => (
              <li key={task.id} className={`task-${task.status}`}>
                <span className="task-symbol" aria-hidden="true">
                  {taskSymbols[task.status] || "○"}
                </span>
                <div>
                  <span>{task.text}</span>
                  <small>{taskLabels[task.status] || commonCopy.pendingTask}</small>
                </div>
              </li>
            ))}
          </ol>
        </Group>
      )}
    </Modal>
  );
}
