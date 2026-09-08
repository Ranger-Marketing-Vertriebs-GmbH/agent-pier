import React, { useState } from "react";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ConfirmAction from "./ConfirmAction.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/de/pipelines.js";
export default function RunActions({ run, refresh, removed }) {
  const [feedback, setFeedback] = useState(""),
    [resumeAt, setResumeAt] = useState(""),
    [confirm, setConfirm] = useState(null);
  const mutation = useAsyncAction();
  const actions = (run.actions || []).filter((action) => copy.actions[action]);
  const base = `/pipeline-runs/${encodeURIComponent(run.id)}`;
  const execute = async (action) => {
    if (action === "delete") {
      await api(base, "DELETE");
      removed();
      return;
    }
    if (action === "reconcile") {
      const status = await api(base + "/verdict-status");
      if (!status.present) throw Error(status.reason || copy.verdictMissing);
    }
    const suffix =
      action === "retry"
        ? "/retry-stage"
        : action === "create-pr"
          ? "/pull-request"
          : action === "abort" && run.status === "running"
            ? "/cancel"
            : "/gate";
    await api(
      base + suffix,
      "POST",
      suffix === "/gate"
        ? {
            action,
            ...(["feedback", "loop-back"].includes(action) ? { feedback } : {}),
            ...(action === "wait-for-reset" && resumeAt
              ? { resumeAt: new Date(resumeAt).toISOString() }
              : {}),
          }
        : {},
    );
    setConfirm(null);
    setFeedback("");
    refresh();
  };
  if (!actions.length) return null;
  return (
    <section className="pipeline-card pipeline-gate">
      {actions.some((action) => ["feedback", "loop-back"].includes(action)) && (
        <label>
          {copy.feedback}
          <textarea
            aria-label={copy.feedback}
            rows={3}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
          />
        </label>
      )}
      {actions.includes("wait-for-reset") && (
        <label>
          {copy.resumeAt}
          <input
            type="datetime-local"
            value={resumeAt}
            onChange={(event) => setResumeAt(event.target.value)}
          />
        </label>
      )}
      <div className="pipeline-actions">
        {actions.map((action) => (
          <button
            key={action}
            className={`button ${action === "accept" ? "primary" : "secondary"}`}
            disabled={mutation.busy || (action === "feedback" && !feedback.trim())}
            onClick={() =>
              ["delete", "abort", "override", "create-pr"].includes(action)
                ? setConfirm(action)
                : mutation.run(() => execute(action))
            }
          >
            {copy.actions[action]}
          </button>
        ))}
      </div>
      <ErrorMessage error={mutation.error} />
      {confirm && (
        <ConfirmAction
          label={copy.actions[confirm]}
          description={
            confirm === "delete"
              ? copy.deleteRun
              : confirm === "abort"
                ? copy.cancelRun
                : confirm === "create-pr"
                  ? copy.prConfirm
                  : copy.overrideRun
          }
          close={() => setConfirm(null)}
          action={() => execute(confirm)}
        />
      )}
    </section>
  );
}
