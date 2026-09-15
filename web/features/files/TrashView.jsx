import React, { useEffect, useMemo, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { filesCopy as copy } from "../../lib/i18n/messages/files.js";
import useFileSelection from "./useFileSelection.js";
import useTrash from "./useTrash.js";
import { operation, purgeBatches, isTerminal } from "./file-action-utils.js";

export default function TrashView({ scope, client, jobs, onChanged, onOpenOriginal }) {
  const trash = useTrash(client, scope.scopeId);
  const [limit, setLimit] = useState(200);
  const [dialog, setDialog] = useState(null);
  const [restoreDialog, setRestoreDialog] = useState(null);
  const [target, setTarget] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState(null);
  const busyRef = useRef(false),
    alive = useRef(true),
    runRef = useRef(null);
  const restoreAttempt = useRef(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const items = useMemo(
    () =>
      trash.entries
        .filter((entry) => entry.availability === "recoverable")
        .map((entry) => ({ ...entry, path: entry.id })),
    [trash.entries],
  );
  const renderedItems = useMemo(
    () =>
      trash.entries
        .slice(0, limit)
        .filter((entry) => entry.availability === "recoverable")
        .map((entry) => ({ ...entry, path: entry.id })),
    [limit, trash.entries],
  );
  const selection = useFileSelection(renderedItems, client);
  const selected = selection.selected;
  const handleShortcuts = (event) => {
    if (
      event.defaultPrevented ||
      scope.readOnly ||
      !event.currentTarget.contains(document.activeElement) ||
      event.target.closest(
        "dialog, input:not([type='checkbox']):not([type='radio']), textarea, select, [contenteditable='true']",
      )
    )
      return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selection.selectAll();
    } else if (event.key === "Escape") selection.clear();
  };
  const unavailable = trash.entries.filter(
    (entry) => entry.availability !== "recoverable",
  );
  const known = items.filter((entry) => Number.isSafeInteger(entry.size));
  const unknown = trash.entries.length - known.length;
  const refresh = () => {
    trash.refresh();
    onChanged();
  };
  const finishedJobs = jobs.jobs
    .filter((job) => !["search", "size"].includes(job.kind) && isTerminal(job))
    .map((job) => `${job.id}:${job.status}:${job.completedEntries}`)
    .join("|");
  useEffect(() => {
    if (finishedJobs) trash.refresh();
    // Job completion refreshes the view without an extra polling timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedJobs]);
  const freeze = (entries) => {
    setError(null);
    setDialog({
      entries: entries.map((entry) => ({ ...entry })),
      excluded: unavailable.length,
    });
  };
  const startBatch = async (value) => {
    if (!alive.current || value.stopped || value.pending || runRef.current !== value)
      return;
    value.pending = true;
    const body = value.batches[value.index];
    const submittedBatch = { id: null, sources: body.sources, requestId: body.requestId };
    value.submitted.push(submittedBatch);
    try {
      const job = await jobs.start(scope.scopeId, body);
      submittedBatch.id = job.id;
      if (value.stopped && alive.current)
        jobs.cancel(scope.scopeId, job.id).catch(() => {});
      value.index++;
    } catch (issue) {
      value.stopped = true;
      value.error = issue;
    } finally {
      value.pending = false;
      if (alive.current && runRef.current === value) setRun({ ...value });
    }
  };
  const confirm = () => {
    if (!dialog || runRef.current?.pending) return;
    const value = {
      entries: dialog.entries,
      batches: purgeBatches(dialog.entries),
      submitted: [],
      index: 0,
      pending: false,
      stopped: false,
    };
    runRef.current = value;
    setRun({ ...value });
    setDialog(null);
    selection.clear();
    startBatch(value);
  };
  const lastJobId = run?.submitted.at(-1)?.id;
  const lastJob = jobs.jobs.find((job) => job.id === lastJobId);
  const lastPage = jobs.entries[lastJobId];
  useEffect(() => {
    const value = runRef.current;
    if (
      !value ||
      value.pending ||
      value.stopped ||
      !isTerminal(lastJob) ||
      !lastPage?.complete
    )
      return;
    if (value.handled === lastJobId) return;
    value.handled = lastJobId;
    const sources = value.submitted.at(-1).sources;
    const completed = new Set(
      lastPage.entries
        .filter((row) => row.status === "completed" && row.sourceRemoved === true)
        .map((row) => row.source),
    );
    if (lastJob.status !== "completed" || sources.some((id) => !completed.has(id)))
      value.stopped = true;
    refresh();
    if (!value.stopped && value.index < value.batches.length) startBatch(value);
    else setRun({ ...value });
    // The run owns fixed requests; polling only advances after proven batch outcomes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastJobId, lastJob?.status, lastPage?.complete, lastPage?.version]);
  const stop = () => {
    const value = runRef.current;
    if (!value) return;
    value.stopped = true;
    setRun({ ...value });
    if (lastJobId && !isTerminal(lastJob))
      jobs.cancel(scope.scopeId, lastJobId).catch(() => {});
  };
  const restoring = async (entry, chosen, explicit = false) => {
    if (busyRef.current || scope.readOnly) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const parent =
        chosen.split("/").slice(0, -1).join("/") || (scope.kind === "global" ? "/" : "");
      try {
        const metadata = await client.get("/metadata", { path: parent });
        if (!alive.current) return;
        if (metadata.type !== "directory")
          throw new Error(copy.errors.FILE_NOT_DIRECTORY);
      } catch (issue) {
        if (!alive.current) return;
        setRestoreDialog(entry);
        setTarget(chosen);
        if (explicit) setError(issue);
        return;
      }
      if (!alive.current) return;
      const body = restoreAttempt.current || operation("restore", [entry.id], chosen);
      restoreAttempt.current = body;
      await jobs.start(scope.scopeId, body);
      if (alive.current) {
        setRestoreDialog(null);
        selection.clear();
        refresh();
      }
    } catch (issue) {
      if (alive.current) {
        setError(issue);
        setRestoreDialog(entry);
        setTarget(chosen);
      }
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const active =
    run &&
    !run.stopped &&
    (run.pending ||
      !lastPage?.complete ||
      run.index < run.batches.length ||
      (lastJob && !isTerminal(lastJob)));
  const submitted = new Set(run?.submitted.flatMap((batch) => batch.sources) || []);
  const results = new Map(
    run?.submitted
      .flatMap((batch) => jobs.entries[batch.id]?.entries || [])
      .map((row) => [row.source, row]) || [],
  );
  return (
    <section
      className="file-trash"
      aria-label={copy.actions.trashTitle}
      onKeyDown={handleShortcuts}
    >
      <h2>{copy.actions.trashTitle}</h2>
      <p>{copy.actions.trashPolicy}</p>
      {trash.loading ? (
        <p role="status">{copy.actions.loadingTrash}</p>
      ) : (
        <p>
          {copy.actions.usage(
            known.reduce((sum, entry) => sum + entry.size, 0),
            unknown,
          )}
        </p>
      )}
      <ErrorMessage
        error={trash.error?.message || error?.message || run?.error?.message}
      />
      <div className="file-action-buttons">
        <button
          className="button secondary"
          disabled={busy || scope.readOnly || selected.length !== 1}
          onClick={() => {
            restoreAttempt.current = null;
            restoring(selected[0], selected[0].originalPath);
          }}
        >
          {copy.actions.restore}
        </button>
        <button
          className="button secondary"
          disabled={scope.readOnly || !selected.length || Boolean(active)}
          onClick={() => freeze(selected)}
        >
          {copy.actions.permanentDelete}
        </button>
        <button
          className="button secondary"
          disabled={scope.readOnly || trash.loading || !items.length || Boolean(active)}
          onClick={() => freeze(items)}
        >
          {copy.actions.emptyTrash}
        </button>
        <button className="button secondary" onClick={refresh}>
          {copy.actions.refreshTrash}
        </button>
      </div>
      {!trash.loading && !trash.entries.length && <p>{copy.actions.trashEmpty}</p>}
      <ul className="file-trash-list">
        {trash.entries.slice(0, limit).map((entry) => (
          <li key={entry.id}>
            <label>
              <input
                type="checkbox"
                aria-label={copy.actions.select(entry.originalPath.split("/").at(-1))}
                disabled={entry.availability !== "recoverable" || scope.readOnly}
                checked={selected.some((item) => item.id === entry.id)}
                onChange={(event) =>
                  event.nativeEvent.shiftKey
                    ? selection.range(entry.id)
                    : selection.toggle(entry.id)
                }
              />
              <span>{entry.originalPath}</span>
            </label>
            <span>
              {copy.types[entry.type]} · {copy.actions.reasons[entry.reason]} ·{" "}
              {new Date(entry.deletedAt).toLocaleString()}
            </span>
            <span>
              {entry.availability === "recoverable" && entry.size !== null
                ? copy.measuredSize(entry.size)
                : copy.actions.unknownSize}{" "}
              · {copy.actions.availability[entry.availability]}
            </span>
            {entry.availability !== "recoverable" && (
              <>
                <p>{copy.actions.recoveryInfo}</p>
                <button className="button secondary compact" onClick={refresh}>
                  {copy.actions.checkRecovery}
                </button>
              </>
            )}
            <button
              className="button secondary compact"
              onClick={() => onOpenOriginal(entry.originalPath)}
            >
              {copy.actions.originalLocation}
            </button>
          </li>
        ))}
      </ul>
      {limit < trash.entries.length && (
        <button
          className="button secondary"
          onClick={() => setLimit((value) => value + 200)}
        >
          {copy.actions.moreTrash}
        </button>
      )}
      {run && (
        <section aria-label={copy.actions.purgeResults}>
          <h3>{copy.actions.purgeResults}</h3>
          {active && (
            <button className="button secondary" onClick={stop}>
              {copy.stop}
            </button>
          )}
          <ul className="file-frozen-selection">
            {run.entries.map((entry) => {
              const row = results.get(entry.id);
              const status =
                row?.status === "completed" && row.sourceRemoved === true
                  ? "removed"
                  : submitted.has(entry.id)
                    ? "uncertain"
                    : "unsubmitted";
              return (
                <li key={entry.id}>
                  {entry.originalPath} · {copy.actions.outcomes[status]}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {dialog && (
        <Modal
          className="file-action-dialog"
          title={copy.actions.permanentDelete}
          close={() => setDialog(null)}
        >
          <p>{copy.actions.purgeConfirm(dialog.entries.length, dialog.excluded)}</p>
          <p>{copy.actions.batchPolicy}</p>
          <ul className="file-frozen-selection">
            {dialog.entries.map((entry) => (
              <li key={entry.id}>{entry.originalPath}</li>
            ))}
          </ul>
          <div className="file-action-buttons">
            <button className="button" onClick={confirm}>
              {copy.actions.confirm}
            </button>
            <button className="button secondary" onClick={() => setDialog(null)}>
              {copy.actions.choices.cancel}
            </button>
          </div>
        </Modal>
      )}
      {restoreDialog && (
        <Modal
          className="file-action-dialog"
          title={copy.actions.restoreDestination}
          close={() => {
            if (!busy) setRestoreDialog(null);
          }}
          closeDisabled={busy}
        >
          <p>{copy.actions.parentMissing}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              restoring(restoreDialog, target, true);
            }}
          >
            <label>
              {copy.path}
              <input
                value={target}
                required
                disabled={busy || Boolean(restoreAttempt.current)}
                onChange={(event) => setTarget(event.target.value)}
              />
            </label>
            <ErrorMessage error={error?.message} />
            <button className="button" disabled={busy}>
              {copy.actions.restore}
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
