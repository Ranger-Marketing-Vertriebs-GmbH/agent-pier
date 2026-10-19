import React, { useEffect, useId, useRef, useState } from "react";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Switch from "../../components/Switch.jsx";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";

const lines = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * A project's risk rules beside its verification steps: path patterns, one per line,
 * and whether an added dependency needs approval. A project without saved rules shows
 * the defaults, which apply until the owner saves.
 */
export default function RiskRulesEditor({
  projectId,
  initial,
  saved,
  onDirtyChange,
  onSaver,
}) {
  const start = {
    globs: initial.globs.join("\n"),
    newDependency: initial.newDependency,
    enabled: initial.enabled !== false,
  };
  const [draft, setDraft] = useState(start);
  const dirty =
    lines(draft.globs).join("\n") !== initial.globs.join("\n") ||
    draft.newDependency !== initial.newDependency ||
    draft.enabled !== (initial.enabled !== false);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const headingId = useId(),
    hintId = useId(),
    dependencyHintId = useId(),
    enabledHintId = useId();
  const action = useAsyncAction();
  function persist() {
    return action.run(async () => {
      await api(`/pipeline-risk/${encodeURIComponent(projectId)}`, "PUT", {
        globs: lines(draft.globs),
        newDependency: draft.newDependency,
        enabled: draft.enabled,
      });
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
      className="pipeline-form verification-card risk-rules-card"
      aria-labelledby={headingId}
      onSubmit={(event) => {
        event.preventDefault();
        persist();
      }}
    >
      <fieldset disabled={action.busy}>
        <header className="verification-head">
          <div>
            <h2 id={headingId}>{copy.riskRules}</h2>
            <p>{copy.riskRulesHelp}</p>
            <p>{initial.custom ? copy.riskSavedActive : copy.riskDefaultsActive}</p>
          </div>
          <button
            type="button"
            className="button secondary"
            onClick={() =>
              setDraft({
                globs: initial.defaults.globs.join("\n"),
                newDependency: initial.defaults.newDependency,
                enabled: true,
              })
            }
          >
            {copy.riskRestoreDefaults}
          </button>
        </header>
        <div className="risk-rules-dependency">
          <Switch
            label={copy.riskEnabled}
            checked={draft.enabled}
            aria-describedby={enabledHintId}
            onChange={(enabled) => setDraft({ ...draft, enabled })}
          />
          <small id={enabledHintId}>
            {draft.enabled ? copy.riskEnabledHint : copy.riskDisabledHint}
          </small>
        </div>
        <label className="risk-rules-globs">
          {copy.riskGlobs}
          <textarea
            aria-describedby={hintId}
            rows={10}
            spellCheck={false}
            value={draft.globs}
            onChange={(event) => setDraft({ ...draft, globs: event.target.value })}
          />
          <small id={hintId}>{copy.riskGlobsHint}</small>
        </label>
        <div className="risk-rules-dependency">
          <Switch
            label={copy.riskNewDependency}
            checked={draft.newDependency}
            aria-describedby={dependencyHintId}
            onChange={(newDependency) => setDraft({ ...draft, newDependency })}
          />
          <small id={dependencyHintId}>{copy.riskNewDependencyHint}</small>
        </div>
      </fieldset>
      <ErrorMessage error={action.error} />
      <div className="profile-footer">
        <button className="button primary" disabled={action.busy}>
          {copy.riskSave}
        </button>
      </div>
    </form>
  );
}
