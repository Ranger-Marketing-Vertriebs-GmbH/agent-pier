import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { filesCopy as copy } from "../../lib/i18n/messages/files.js";
import { actionLayoutCopy as layoutCopy } from "../../lib/i18n/messages/action-layout.js";
import { operation, transferOperation, references, bytes } from "./file-action-utils.js";
import "./file-actions.css";
import FileArchiveDialog, { archiveActions, canExtract } from "./FileArchiveDialog.jsx";
import FileActionMenu from "./FileActionMenu.jsx";

export default function FileActions({
  scope,
  selection,
  refreshing = false,
  clipboard,
  jobs,
  onChanged,
  request,
  onRequestHandled,
  toolbarTarget,
}) {
  const [dialog, setDialog] = useState(null);
  const [name, setName] = useState("");
  const [error, setError] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [pendingDialog, setPendingDialog] = useState(null);
  const dialogOwner = useRef(null);
  const attempt = useRef(null);
  const alive = useRef(true);
  const busy = useRef(null);
  const selected = selection.selected;
  const signature = selected.map((item) => `${item.path}\0${item.revision}`).join("\n");
  // A same-query refresh has no authoritative entries yet. Keep ordinary frozen
  // confirmations visible but pause submission until their revisions are checked.
  const paused = refreshing && dialog && !archiveActions.includes(dialog.kind);
  const validDialog =
    dialog &&
    (paused ||
      ((!dialog.signature || dialog.signature === signature) &&
        (!dialog.bindEntries ||
          dialog.items.every((item) =>
            selection.entries.some(
              (entry) => entry.path === item.path && entry.revision === item.revision,
            ),
          ))));
  const currentDialog = validDialog ? dialog : null;
  // Invalidate during render, before a pending response or cleanup effect can run.
  if (!validDialog && dialogOwner.current === dialog) dialogOwner.current = null;
  const pending = Boolean(currentDialog && pendingDialog === currentDialog);
  const replaceDialog = (value) => {
    const restore = !value && dialogOwner.current?.restoreFocus;
    dialogOwner.current = value;
    attempt.current = null;
    setPendingDialog(null);
    setDialog(value);
    if (restore) requestAnimationFrame(() => alive.current && restore());
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      dialogOwner.current = null;
    };
  }, []);
  useEffect(() => {
    if (dialog && !validDialog)
      setDialog((current) => (current === dialog ? null : current));
  }, [dialog, validDialog]);

  const show = (kind, items = selected, extra = {}) => {
    if (
      scope.readOnly &&
      !["copy", "path", "download_zip", "download_folder"].includes(kind)
    )
      return;
    if (kind.startsWith("extract_") && !canExtract(items)) return;
    setError(null);
    setFeedback(null);
    if (kind === "copy" || kind === "cut") {
      replaceDialog(null);
      if (items.length) {
        clipboard[kind](items);
        setFeedback(kind);
      }
      requestAnimationFrame(() => alive.current && extra.restoreFocus?.());
      return;
    }
    if (kind === "path") {
      replaceDialog(null);
      const paths = items.map((item) => item.path).join("\n");
      Promise.resolve()
        .then(() => navigator.clipboard.writeText(paths))
        .then(() => {
          if (alive.current) setFeedback("path");
        })
        .catch(() => {
          if (alive.current) setFeedback("copyFailed");
        })
        .finally(() =>
          requestAnimationFrame(() => alive.current && extra.restoreFocus?.()),
        );
      return;
    }
    if (kind === "paste") {
      if (!clipboard.items.length) return;
      replaceDialog({
        kind: clipboard.action === "cut" ? "move" : "copy",
        items: references(clipboard.items),
        target: scope.path,
        token: clipboard.token,
        ...extra,
      });
    } else {
      setName(kind === "rename" ? items[0]?.name || "" : "");
      replaceDialog({
        kind,
        items: archiveActions.includes(kind)
          ? items.map((item) => ({ ...item }))
          : references(items),
        bindEntries: ["rename", "trash", "move", ...archiveActions].includes(kind),
        signature: items === selected ? signature : null,
        ...extra,
      });
    }
  };
  const lastRequest = useRef(null);
  useEffect(() => {
    if (!request || request === lastRequest.current) return;
    lastRequest.current = request;
    show(request.kind, request.items || selected, {
      ...(request.target ? { target: request.target } : {}),
      ...(request.restoreFocus ? { restoreFocus: request.restoreFocus } : {}),
    });
    onRequestHandled?.();
    // Requests are explicit user gestures owned by this opened scope/path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);
  const submit = async (event) => {
    event.preventDefault();
    if (
      !currentDialog ||
      paused ||
      busy.current === currentDialog ||
      dialogOwner.current !== currentDialog
    )
      return;
    const value = currentDialog;
    const owns = () => alive.current && dialogOwner.current === value;
    let body = attempt.current;
    if (!body) {
      body = ["copy", "move"].includes(value.kind)
        ? transferOperation(value.kind, value.items, value.target)
        : value.kind === "rename"
          ? operation(
              "rename",
              value.items.map((item) => item.path),
              null,
              name,
              {
                revisions: Object.fromEntries(
                  value.items.map((item) => [item.path, item.revision]),
                ),
              },
            )
          : value.kind === "trash"
            ? operation(
                "trash",
                value.items.map((item) => item.path),
              )
            : operation(value.kind, [], scope.path, name);
      attempt.current = body;
    }
    if (bytes(body) > 64 * 1024) {
      setError({ message: copy.errors.FILE_LIMIT_EXCEEDED });
      return;
    }
    busy.current = value;
    setPendingDialog(value);
    setError(null);
    try {
      const job = await jobs.start(scope.scopeId, body);
      if (value.token && value.kind === "move") clipboard.track(value.token, job.id);
      if (!owns()) return;
      replaceDialog(null);
      selection.clear();
      onChanged(value.restoreFocus);
    } catch (issue) {
      if (owns()) setError(issue);
    } finally {
      if (busy.current === value) busy.current = null;
      if (owns()) setPendingDialog(null);
    }
  };
  const titles = {
    create_file: copy.actions.newFile,
    create_directory: copy.actions.newFolder,
    rename: copy.actions.rename,
    trash: copy.actions.trash,
    copy: copy.actions.copy,
    move: copy.actions.move,
  };
  const newActions = [
    {
      kind: "create_file",
      label: copy.actions.newFile,
      onClick: (extra) => show("create_file", selected, extra),
    },
    {
      kind: "create_directory",
      label: copy.actions.newFolder,
      onClick: (extra) => show("create_directory", selected, extra),
    },
  ];
  const advancedActions = archiveActions
    .filter((kind) => kind !== "download_folder")
    .map((kind) => ({
      kind,
      label: copy.transfers.actions[kind],
      hidden:
        (scope.readOnly && !kind.startsWith("download_")) ||
        (kind === "download_zip" && !selected.length) ||
        (kind.startsWith("extract_") && !canExtract(selected)),
      onClick: (extra) => show(kind, selected, extra),
    }));
  const primaryActions = (
    <div className="file-primary-actions">
      {!scope.readOnly && (
        <FileActionMenu label={layoutCopy.new} icon="plus" items={newActions} />
      )}
      {clipboard.items.length > 0 && (
        <button
          type="button"
          className="button secondary compact"
          disabled={scope.readOnly}
          onClick={() => show("paste")}
        >
          {copy.actions.paste}
        </button>
      )}
      <FileActionMenu
        label={layoutCopy.more}
        compact
        items={[
          {
            kind: "archive",
            label: copy.transfers.actions.archive,
            hidden: scope.readOnly,
            onClick: (extra) => show("archive", [], extra),
          },
          {
            kind: "download_folder",
            label: copy.transfers.actions.download_folder,
            onClick: (extra) => show("download_folder", [], extra),
          },
        ]}
      />
    </div>
  );
  return (
    <section className="file-actions" aria-label={copy.actions.label}>
      {toolbarTarget ? createPortal(primaryActions, toolbarTarget) : primaryActions}
      {selected.length > 0 && (
        <div
          className="file-selection-actions"
          role="group"
          aria-label={layoutCopy.selected}
        >
          <button className="button secondary compact" onClick={() => show("copy")}>
            {copy.actions.copy}
          </button>
          {!scope.readOnly && (
            <button className="button secondary compact" onClick={() => show("cut")}>
              {copy.actions.cut}
            </button>
          )}
          {!scope.readOnly && selected.length === 1 && (
            <button className="button secondary compact" onClick={() => show("rename")}>
              {copy.actions.rename}
            </button>
          )}
          <button className="button secondary compact" onClick={() => show("path")}>
            {copy.actions.copyPath}
          </button>
          {!scope.readOnly && (
            <button className="button secondary compact" onClick={() => show("trash")}>
              {copy.actions.trash}
            </button>
          )}
          {advancedActions.some((item) => !item.hidden) && (
            <FileActionMenu label={layoutCopy.more} items={advancedActions} />
          )}
          <button className="button secondary compact" onClick={selection.clear}>
            {copy.actions.clearSelection}
          </button>
        </div>
      )}
      {(selected.length > 0 || clipboard.items.length > 0) && (
        <p className="field-description file-action-status">
          {selected.length > 0 && copy.actions.selection(selected.length)}{" "}
          {clipboard.items.length > 0 &&
            copy.actions.clipboard(
              clipboard.items.length,
              copy.actions[clipboard.action],
            )}
        </p>
      )}
      {feedback && (
        <p role="status">
          {feedback === "copyFailed"
            ? copy.copyFailed
            : feedback === "path"
              ? copy.copied
              : copy.actions.clipboardReady}
        </p>
      )}
      {currentDialog && archiveActions.includes(currentDialog.kind) && (
        <FileArchiveDialog
          key={currentDialog.kind}
          selection={currentDialog.items}
          folder={scope}
          jobs={jobs}
          kind={currentDialog.kind}
          onClose={(started) => {
            if (dialogOwner.current !== currentDialog) return;
            replaceDialog(null);
            if (started) onChanged();
          }}
        />
      )}
      {currentDialog && !archiveActions.includes(currentDialog.kind) && (
        <Modal
          className="file-action-dialog"
          title={titles[currentDialog.kind]}
          close={() => {
            if (!pending) replaceDialog(null);
          }}
          closeDisabled={pending}
        >
          <form onSubmit={submit}>
            {["create_file", "create_directory", "rename"].includes(
              currentDialog.kind,
            ) && (
              <label>
                {copy.name}
                <input
                  name="name"
                  value={name}
                  required
                  autoFocus
                  disabled={pending || Boolean(attempt.current)}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            )}
            {currentDialog.kind === "trash" && <p>{copy.actions.trashConfirm}</p>}
            {["copy", "move"].includes(currentDialog.kind) && (
              <p>{copy.actions.destination(currentDialog.target)}</p>
            )}
            <ul className="file-frozen-selection">
              {currentDialog.items.map((item) => (
                <li key={item.path}>{item.path}</li>
              ))}
            </ul>
            <ErrorMessage error={error?.message} />
            <div className="file-action-buttons">
              <button className="button" disabled={pending || paused || scope.readOnly}>
                {copy.actions.confirm}
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={pending}
                onClick={() => replaceDialog(null)}
              >
                {copy.actions.choices.cancel}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
