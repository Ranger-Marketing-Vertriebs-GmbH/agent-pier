import { checkLabel } from "./diagnostic-labels.js";
import React, { useState } from "react";
import api from "../../lib/api.js";
import useResource from "../../lib/useResource.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { operationsCopy as copy } from "../../lib/i18n/de/operations.js";
export default function DiagnosticsPage() {
  const resource = useResource("/operations/doctor"),
    projects = useResource("/memory/projects"),
    action = useAsyncAction();
  const [scope, setScope] = useState("host"),
    [projectId, setProjectId] = useState(""),
    [deep, setDeep] = useState(false);
  const report = resource.data?.report;
  return (
    <section>
      <h1>{copy.diagnostics}</h1>
      <form
        className="operations-filters"
        onSubmit={(event) => {
          event.preventDefault();
          action.run(async () =>
            resource.update(
              await api("/operations/doctor", "POST", {
                scope,
                ...(scope === "project" ? { projectId } : {}),
                deep,
              }),
            ),
          );
        }}
      >
        <label>
          {copy.scope}
          <AnchoredSelect
            label={copy.scope}
            value={scope}
            disabled={action.busy}
            onChange={setScope}
            options={[
              { value: "host", label: copy.host },
              { value: "project", label: copy.project },
            ]}
          />
        </label>
        {scope === "project" && (
          <label>
            {copy.project}
            <AnchoredSelect
              label={copy.project}
              value={projectId}
              disabled={action.busy}
              required
              onChange={setProjectId}
              options={[
                { value: "", label: copy.chooseProject },
                ...(projects.data?.projects || []).map((project) => ({
                  value: project.id,
                  label: project.name,
                })),
              ]}
            />
          </label>
        )}
        <label className="operations-check">
          <input
            type="checkbox"
            checked={deep}
            disabled={action.busy}
            onChange={(event) => setDeep(event.target.checked)}
          />
          {copy.deep}
        </label>
        <button className="button primary" disabled={action.busy}>
          {copy.runChecks}
        </button>
      </form>
      <p className="field-description">{copy.deepHelp}</p>
      <ErrorMessage error={resource.error || projects.error || action.error} />
      {resource.loading && <p role="status">{copy.loading}</p>}
      {!resource.loading && !report && <p>{copy.noReport}</p>}
      {report && (
        <>
          <p>
            {copy.generatedAt}: {formatTimestamp(report.generatedAt)}
          </p>
          {report.checks.map((check) => (
            <article
              className={`operations-card ${check.status === "fail" ? "operations-error" : check.status === "warn" ? "operations-warning" : ""}`}
              key={check.id}
            >
              <header>
                <strong>{checkLabel(check.id)}</strong>
                <span>{copy.checkStatuses[check.status] || copy.unknown}</span>
              </header>
              <p>{check.summary}</p>
              {check.remedy && (
                <>
                  <h3>{copy.remedy}</h3>
                  <pre>
                    {typeof check.remedy === "string"
                      ? check.remedy
                      : JSON.stringify(check.remedy, null, 2)}
                  </pre>
                </>
              )}
              {check.details && (
                <details>
                  <summary>{copy.details}</summary>
                  <pre>
                    {typeof check.details === "string"
                      ? check.details
                      : JSON.stringify(check.details, null, 2)}
                  </pre>
                </details>
              )}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
