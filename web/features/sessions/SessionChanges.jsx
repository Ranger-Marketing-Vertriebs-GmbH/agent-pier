import React, { useEffect, useMemo, useState } from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import DiffReview from "../../components/diff/DiffReview.jsx";
import api from "../../lib/api.js";
import { sessionChangesCopy as copy } from "../../lib/i18n/messages/sessions.js";
import useReviewComments from "../review/useReviewComments.js";
import {
  baseLine,
  diffKey,
  shownWorkspace,
  workspaceLabel,
} from "./session-changes-state.js";
import "./session-changes.css";

const diffPath = (sessionId, workspace) =>
  `/sessions/${encodeURIComponent(sessionId)}/changes/diff?${new URLSearchParams({ workspace })}`;

/**
 * The working-tree diff of one picked workspace. It is read when the tab opens, when
 * another workspace is picked and when the summary's entry for it changes (`key`), so
 * pushes drive it and no timer does. A 404 (the worktree was removed) reads the summary
 * again and falls back to the first workspace.
 */
function useWorkspaceDiff(sessionId, workspace, key, { refresh, forget }) {
  const [state, setState] = useState({ workspace: null, data: null, error: "" });
  useEffect(() => {
    if (workspace === null) return;
    const controller = new AbortController();
    // A new read clears the last error; the shown diff stays until an answer.
    setState((last) => (last.error ? { ...last, error: "" } : last));
    api(diffPath(sessionId, workspace), "GET", undefined, controller.signal).then(
      (data) => setState({ workspace, data, error: "" }),
      (error) => {
        if (controller.signal.aborted) return;
        if (error?.status === 404) {
          forget();
          refresh();
          return;
        }
        // A failed refresh keeps the diff (and any comment draft in it) beside the error.
        const message = error?.message || String(error);
        setState((last) =>
          last.workspace === workspace
            ? { ...last, error: message }
            : { workspace, data: null, error: message },
        );
      },
    );
    return () => controller.abort();
    // `key` stands for the entry: a new base, file count or line count reads again.
  }, [sessionId, workspace, key, refresh, forget]);
  return state.workspace === workspace ? state : { workspace, data: null, error: "" };
}

/**
 * A session's Changes tab: the workspace picker (changed ones first), what the diff is
 * measured against, and the diff with its line comments. `changes` is the session's
 * useSessionChanges() result, which the tab badge shares. `toolbar` sits above the
 * diff (the Send to agent area); as a function it receives `{ comments, readDiff,
 * markSent }`: every comment of the session, a reader of any workspace's files that
 * answers the shown workspace's loaded diff without a request, and the hook's write.
 */
export default function SessionChanges({ session, changes, toolbar = null }) {
  const { summary, loading, error, refresh } = changes;
  const [picked, setPicked] = useState(null);
  const workspace = shownWorkspace(summary, picked);
  const entry = summary?.workspaces?.find((item) => item.id === workspace);
  const forget = useMemo(() => () => setPicked(null), []);
  const diff = useWorkspaceDiff(session.id, workspace, diffKey(entry), {
    refresh,
    forget,
  });
  const review = useReviewComments({ kind: "session", id: session.id });
  const comments = useMemo(
    () => review.comments.filter((comment) => comment.workspace === workspace),
    [review.comments, workspace],
  );
  const loaded = diff.data ? diff.data.files : null;
  const readDiff = (id) =>
    id === workspace && loaded
      ? loaded
      : api(diffPath(session.id, id)).then(
          (data) => data.files,
          () => null,
        );

  if (!summary && (error || loading))
    return (
      <div className="session-changes">
        {error ? <ErrorMessage error={error} /> : <p>{copy.loading}</p>}
      </div>
    );
  // a login session follows no summary
  if (!summary?.repository || !entry)
    return (
      <div className="session-changes">
        <p className="session-changes-note">{copy.notRepository}</p>
      </div>
    );
  const workspaces = summary.workspaces;
  const bar =
    typeof toolbar === "function"
      ? toolbar({ comments: review.comments, readDiff, markSent: review.markSent })
      : toolbar;
  return (
    <div className="session-changes">
      <div className="session-changes-head">
        {workspaces.length > 1 ? (
          <AnchoredSelect
            label={copy.workspace}
            value={workspace}
            onChange={setPicked}
            options={workspaces.map((item) => ({
              value: item.id,
              label: workspaceLabel(item, copy),
            }))}
          />
        ) : (
          <p className="session-changes-workspace">{workspaceLabel(entry, copy)}</p>
        )}
        <p className="session-changes-base">
          {baseLine(entry.base, summary.startCommit, copy)}
        </p>
      </div>
      <ErrorMessage error={diff.error || review.error} />
      {diff.data ? (
        <DiffReview
          files={diff.data.files}
          comments={comments}
          workspace={workspace}
          truncated={diff.data.truncated}
          onCreate={review.create}
          onUpdate={review.update}
          onDelete={review.remove}
          toolbar={bar}
          empty={
            <>
              {bar}
              <p className="session-changes-note">{copy.noChanges}</p>
            </>
          }
        />
      ) : (
        !diff.error && <p>{copy.loading}</p>
      )}
    </div>
  );
}
