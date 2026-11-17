import React, { useLayoutEffect, useRef, useState } from "react";
import ListCard from "../../components/ListCard.jsx";
import Modal from "../../components/Modal.jsx";
import { backgroundTasksCopy as copy } from "../../lib/i18n/messages/chat.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { completedStartsOpen } from "./background-tasks.js";
import BackgroundTaskCard from "./BackgroundTaskCard.jsx";
import BackgroundTaskDetail from "./BackgroundTaskDetail.jsx";

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

function Cards({ entries, label, ...props }) {
  return (
    <ListCard label={label}>
      {entries.map((entry) => (
        <BackgroundTaskCard key={`${entry.kind}:${entry.id}`} entry={entry} {...props} />
      ))}
    </ListCard>
  );
}

/**
 * Which entry the sheet shows in detail. The list stays mounted (hidden), so its
 * fold state survives; its scroll position and the focused opener come back on return.
 */
function useDetail(entries) {
  const [open, setOpen] = useState(null);
  const list = useRef(null);
  const saved = useRef(null);
  const entry =
    open && entries.find((item) => item.kind === open.kind && item.id === open.id);
  const shown = Boolean(entry);
  useLayoutEffect(() => {
    if (shown) return;
    // An entry that left the list closes its detail for good.
    setOpen(null);
    if (!saved.current) return;
    const { scrollTop, opener } = saved.current;
    saved.current = null;
    const dialog = list.current?.closest("dialog");
    if (dialog) dialog.scrollTop = scrollTop;
    // A card that moved to another group while its detail was open is a new element.
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    else dialog?.focus({ preventScroll: true });
  }, [shown]);
  return {
    list,
    entry,
    view: open?.view,
    show: (item, view, opener) => {
      const dialog = list.current?.closest("dialog");
      saved.current = { scrollTop: dialog?.scrollTop ?? 0, opener };
      setOpen({ kind: item.kind, id: item.id, view });
      if (dialog) dialog.scrollTop = 0;
    },
    back: () => setOpen(null),
  };
}

/**
 * The sheet behind the line above the composer: working subagents and shells,
 * finished ones and the CLI's to-dos, each in a group that can be folded, and the
 * transcript or output of one task in place of the list. A bottom sheet on phones,
 * a centred dialog on desktop (`Modal`).
 */
export default function BackgroundTasksSheet({
  running = [],
  finished = [],
  tasks = [],
  session,
  openFile,
  close,
}) {
  const detail = useDetail([...running, ...finished]);
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
      {detail.entry && (
        <BackgroundTaskDetail
          entry={detail.entry}
          view={detail.view}
          session={session}
          openFile={openFile}
          onBack={detail.back}
        />
      )}
      <div ref={detail.list} hidden={Boolean(detail.entry)}>
        {running.length > 0 && (
          <Group id="running" label={copy.running} open>
            <Cards
              entries={running}
              label={copy.running}
              sessionId={session.id}
              onOpen={detail.show}
              timed
            />
          </Group>
        )}
        {finished.length > 0 && (
          <Group
            id="completed"
            label={copy.completed}
            count={finished.length}
            open={completedOpen}
          >
            <Cards
              entries={finished}
              label={copy.completed}
              sessionId={session.id}
              onOpen={detail.show}
            />
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
      </div>
    </Modal>
  );
}
