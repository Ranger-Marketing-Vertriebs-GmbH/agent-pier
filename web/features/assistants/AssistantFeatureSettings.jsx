import React, { useEffect, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import useAssistantFeature, { FEATURE_CHECK_FAILED } from "./useAssistantFeature.js";
export default function AssistantFeatureSettings() {
  const copy = assistantCopy.feature;
  const { enabled, error, saving, setEnabled, retry } = useAssistantFeature();
  useEffect(retry, [retry]);
  const unknown = error === FEATURE_CHECK_FAILED;
  const [failure, setFailure] = useState("");
  async function toggle(event) {
    setFailure("");
    try {
      await setEnabled(event.target.checked);
    } catch (e) {
      setFailure(e.message);
    }
  }
  const diagnostic = error ? copy.errors[error] || copy.problem(error) : "";
  return (
    <div className="page">
      <article className="assistant-feature">
        <h3>{copy.title}</h3>
        <p>{copy.description}</p>
        <label className="switch-row">
          <input
            type="checkbox"
            role="switch"
            aria-label={copy.title}
            checked={enabled}
            onChange={toggle}
            disabled={saving || unknown}
          />
          {saving ? copy.saving : copy.title}
        </label>
        <ErrorMessage error={failure} />
        <ErrorMessage error={diagnostic && `${copy.diagnostic}: ${diagnostic}`} />
      </article>
    </div>
  );
}
