import React, { useCallback, useEffect, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { projectDeletionCopy as copy } from "../../lib/i18n/messages/project-deletion.js";
import ProjectDeletionReport from "./ProjectDeletionReport.jsx";
import { confirmReady } from "./project-deletion.js";
import "./project-dialogs.css";

// Refusals after which the report is read again: the folder or its projects changed
// (a missing folder that came back turns the dialog into the full delete flow).
const reread = new Set(["PROJECT_DELETE_STALE", "PROJECT_FOLDER_REAPPEARED"]);

/**
 * "Delete project …" (docs/ui-guide.md#confirmations): the server's preflight report,
 * read on open and after each blocker action, then a destructive confirmation. A
 * folder on disk needs the project's name typed exactly; a missing folder ("Remove
 * from AgentPier …") a plain confirm. Nothing is deleted until the owner confirms;
 * `deleted()` follows the server's 202, the deletion itself runs on the server.
 */
export default function DeleteProjectDialog({ project, close, deleted }) {
  const [report, setReport] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [version, setVersion] = useState(0);
  const [typed, setTyped] = useState("");
  // Ticked processes: pid -> the start time the report showed.
  const [ticked, setTicked] = useState(() => new Map());
  const blockers = useAsyncAction();
  // The last blocker action's error; the next action, "Check again" or a confirm
  // clears it, so the confirm's own error is never hidden behind it.
  const [blockerError, setBlockerError] = useState("");
  const path = project.path;
  const show = useCallback((next) => {
    setReport(next);
    setTicked(new Map());
  }, []);
  const rescan = useCallback(() => {
    setBlockerError("");
    setVersion((value) => value + 1);
  }, []);
  useEffect(() => {
    let alive = true;
    setLoadError("");
    api(`/project-deletion?path=${encodeURIComponent(path)}`).then(
      (next) => alive && show(next),
      (error) => alive && setLoadError(error.message),
    );
    return () => {
      alive = false;
    };
  }, [path, version, show]);
  const missing = report
    ? report.folderState === "missing"
    : project.folder === "missing";
  const name = report?.name || project.name;
  const shownPath = report?.path || path;
  // A blocker action answers with the next report; a changed folder reads it again.
  const endBlockers = (body) =>
    blockers.run(async () => {
      setBlockerError("");
      try {
        show(
          await api("/project-deletion/blockers", "POST", {
            path,
            token: report.token,
            ...body,
          }),
        );
      } catch (error) {
        if (reread.has(error.code)) setVersion((value) => value + 1);
        setBlockerError(error.message);
      }
    });
  const tick = (item, on) =>
    setTicked((current) => {
      const next = new Map(current);
      if (on) next.set(item.pid, item.startTime);
      else next.delete(item.pid);
      return next;
    });
  return (
    <ConfirmDialog
      destructive
      className="project-dialog project-delete-dialog"
      title={missing ? copy.removeTitle(name) : copy.deleteTitle(name)}
      body={missing ? copy.removeBody(shownPath) : copy.deleteBody(shownPath)}
      confirmLabel={missing ? copy.confirmRemove : copy.confirmDelete}
      confirmDisabled={!confirmReady(report, typed)}
      busy={blockers.busy}
      error={loadError || blockerError}
      onCancel={close}
      onConfirm={async () => {
        setBlockerError("");
        try {
          await api("/project-deletion", "POST", {
            path,
            token: report.token,
            ...(missing ? {} : { name: typed }),
          });
        } catch (error) {
          if (reread.has(error.code)) rescan();
          throw error;
        }
        deleted();
      }}
    >
      {report ? (
        <ProjectDeletionReport
          report={report}
          ticked={ticked}
          onTick={tick}
          busy={blockers.busy}
          onRescan={rescan}
          onStopSessions={() => endBlockers({ sessions: true })}
          onEndProcesses={() =>
            endBlockers({
              processes: [...ticked].map(([pid, startTime]) => ({ pid, startTime })),
            })
          }
        />
      ) : loadError ? (
        <div className="project-deletion-actions">
          <button type="button" className="button secondary" onClick={rescan}>
            {copy.rescan}
          </button>
        </div>
      ) : (
        <p role="status">{copy.loading}</p>
      )}
      {report && !missing && !report.refused && (
        <label className="project-delete-name">
          {copy.typeName(name)}
          <input
            value={typed}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
      )}
    </ConfirmDialog>
  );
}
