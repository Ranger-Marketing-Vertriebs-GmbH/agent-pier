import React, { useEffect, useId, useRef, useState } from "react";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Switch from "../../components/Switch.jsx";
import useAsyncAction from "../../lib/useAsyncAction.js";
import NumberStepper from "./NumberStepper.jsx";
import { pipelineQueueCopy as copy } from "../../lib/i18n/messages/pipeline-queue.js";

export const MAX_QUEUE_CONCURRENCY = 20;

/**
 * A project's queue limit: how many of its runs may be active at once and whether a
 * run waiting for the owner keeps its slot. Saved in AgentPier's data directory.
 */
export default function QueueSettings({
  projectId,
  initial,
  saved,
  onDirtyChange,
  onSaver,
}) {
  const [draft, setDraft] = useState(initial);
  const dirty =
    draft.limit !== initial.limit || draft.countParked !== initial.countParked;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const headingId = useId(),
    hintId = useId();
  const action = useAsyncAction();
  function persist() {
    return action.run(async () => {
      await api(
        `/pipeline-queue/${encodeURIComponent(projectId)}/settings`,
        "PUT",
        draft,
      );
      onDirtyChange?.(false);
      saved();
      return true;
    });
  }
  const persistRef = useRef(null);
  persistRef.current = persist;
  useEffect(() => {
    onSaver?.(() => persistRef.current());
    return () => onSaver?.(null);
  }, [onSaver]);
  return (
    <form
      className="pipeline-form verification-card queue-settings"
      aria-labelledby={headingId}
      onSubmit={(event) => {
        event.preventDefault();
        persist();
      }}
    >
      <fieldset disabled={action.busy}>
        <header className="verification-head">
          <div>
            <h2 id={headingId}>{copy.settingsHeading}</h2>
            <p>{copy.settingsHelp}</p>
          </div>
        </header>
        <NumberStepper
          label={copy.limit}
          decreaseLabel={copy.fewer}
          increaseLabel={copy.more}
          min={1}
          max={MAX_QUEUE_CONCURRENCY}
          value={draft.limit}
          onChange={(limit) => setDraft({ ...draft, limit })}
          disabled={action.busy}
        />
        <div className="risk-rules-dependency">
          <Switch
            label={copy.countParked}
            checked={draft.countParked}
            aria-describedby={hintId}
            onChange={(countParked) => setDraft({ ...draft, countParked })}
          />
          <small id={hintId}>
            {draft.countParked ? copy.countParkedOn : copy.countParkedOff}
          </small>
        </div>
      </fieldset>
      <ErrorMessage error={action.error} />
      <div className="profile-footer">
        <button className="button primary" disabled={action.busy || !dirty}>
          {copy.saveSettings}
        </button>
      </div>
    </form>
  );
}
