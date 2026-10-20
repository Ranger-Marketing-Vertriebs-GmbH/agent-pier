import React, { useState } from "react";
import api from "../../lib/api.js";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { serverText } from "../../lib/server-messages.js";
import { formatNumber } from "../../lib/i18n/index.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { pipelineCopy } from "../../lib/i18n/messages/pipelines.js";
import { pipelineQueueCopy as copy } from "../../lib/i18n/messages/pipeline-queue.js";
import NewRunDialog from "./NewRunDialog.jsx";
import { runStatusLabel } from "./run-codes.js";
import { runStatusTone } from "./run-presentation.js";
import { runTitle } from "./run-title.js";

const stateTones = { queued: "pending", starting: "running", failed: "error" };
const waiting = (item) => item.state === "queued" || item.state === "failed";

function ItemStatus({ item }) {
  if (item.state !== "started")
    return (
      <StatusChip tone={stateTones[item.state]}>{copy.states[item.state]}</StatusChip>
    );
  if (!item.run) return <StatusChip tone="neutral">{copy.runDeleted}</StatusChip>;
  return (
    <StatusChip tone={runStatusTone(item.run.status)}>
      {copy.runState(runStatusLabel(item.run.status))}
    </StatusChip>
  );
}

function ItemRow({ item, first, last, busy, call, onDelete, onOpenRun }) {
  const title = runTitle(item);
  const base = `/pipeline-queue/${encodeURIComponent(item.projectId)}/items/${encodeURIComponent(item.id)}`;
  const meta = [
    item.pipelineName,
    item.externalRef,
    item.baseBranch && copy.baseBranch(item.baseBranch),
    item.tokenBudget && copy.budget(formatNumber(item.tokenBudget)),
    item.source?.kind === "mcp" && copy.viaMcp,
  ].filter(Boolean);
  return (
    <li className={`queue-item queue-item-${item.state}`}>
      <div className="queue-item-text">
        <strong>{title}</strong>
        <small>{meta.join(" · ")}</small>
        {item.error && <p className="queue-item-error">{serverText(item.error)}</p>}
      </div>
      <ItemStatus item={item} />
      <div className="queue-item-actions">
        {waiting(item) && (
          <>
            <button
              type="button"
              className="icon-button"
              aria-label={copy.moveUp(title)}
              disabled={busy || first}
              onClick={() => call(`${base}/move`, "POST", { direction: "up" })}
            >
              <Icon name="up" size={16} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={copy.moveDown(title)}
              disabled={busy || last}
              onClick={() => call(`${base}/move`, "POST", { direction: "down" })}
            >
              <Icon name="down" size={16} />
            </button>
          </>
        )}
        {item.state === "failed" && (
          <button
            type="button"
            className="button secondary compact"
            disabled={busy}
            onClick={() => call(`${base}/retry`, "POST")}
          >
            {copy.retry}
          </button>
        )}
        {item.state === "started" && item.run && (
          <button
            type="button"
            className="button secondary compact"
            onClick={() => onOpenRun(item.id)}
          >
            {pipelineCopy.openRun}
          </button>
        )}
        {waiting(item) && (
          <button
            type="button"
            className="icon-button"
            aria-label={copy.deleteItem(title)}
            disabled={busy}
            onClick={() => onDelete(item)}
          >
            <Icon name="trash" size={16} />
          </button>
        )}
        {item.state === "started" && (
          <button
            type="button"
            className="icon-button"
            aria-label={copy.removeStarted(title)}
            disabled={busy}
            onClick={() => call(base, "DELETE")}
          >
            <Icon name="close" size={16} />
          </button>
        )}
      </div>
    </li>
  );
}

/** A project's queue: waiting items in order, then started ones with their runs. */
export default function QueueItems({ project, items, refresh, onOpenRun }) {
  const [adding, setAdding] = useState(false),
    [deleting, setDeleting] = useState(null);
  const action = useAsyncAction();
  const call = (path, method, body) =>
    action.run(async () => {
      await api(path, method, body);
      refresh();
    });
  const pending = items.filter(waiting);
  const others = items
    .filter((item) => !waiting(item))
    .sort((a, b) => String(b.startedAt || "~").localeCompare(String(a.startedAt || "~")));
  const rows = [...pending, ...others];
  return (
    <section className="verification-card queue-card" aria-labelledby="queue-heading">
      <header className="verification-head">
        <div>
          <h2 id="queue-heading">{copy.heading}</h2>
          <p>{copy.help}</p>
        </div>
        <button type="button" className="button primary" onClick={() => setAdding(true)}>
          {copy.add}
        </button>
      </header>
      <ErrorMessage error={action.error} />
      {rows.length ? (
        <ol className="queue-items">
          {rows.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              first={pending[0] === item}
              last={pending.at(-1) === item}
              busy={action.busy}
              call={call}
              onDelete={setDeleting}
              onOpenRun={onOpenRun}
            />
          ))}
        </ol>
      ) : (
        <p className="queue-empty">{copy.empty}</p>
      )}
      {adding && (
        <NewRunDialog
          queueProject={project}
          close={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          destructive
          title={copy.deleteTitle(runTitle(deleting))}
          body={copy.deleteBody}
          confirmLabel={commonCopy.delete}
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            await api(
              `/pipeline-queue/${encodeURIComponent(deleting.projectId)}/items/${encodeURIComponent(deleting.id)}`,
              "DELETE",
            );
            setDeleting(null);
            refresh();
          }}
        />
      )}
    </section>
  );
}
