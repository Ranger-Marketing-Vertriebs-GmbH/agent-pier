import React, { useEffect, useState } from "react";
import usePolling from "./usePolling.js";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantWorkflowCopy as copy } from "../../lib/i18n/messages/assistant-workflows.js";
const empty = {
  revision: 0,
  projectIds: [],
  pipelineIds: [],
  memoryWrite: false,
  autonomous: false,
  publish: false,
};
export default function AssistantWorkflows({ assistantId }) {
  const [policy, setPolicy] = useState(null),
    [catalog, setCatalog] = useState({ projects: [], pipelines: [] }),
    [actions, setActions] = useState([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    Promise.all([
      api(`/assistants/${encodeURIComponent(assistantId)}/access`),
      api("/assistant-workspace-catalog"),
    ])
      .then(([p, c]) => {
        if (active) {
          setPolicy({ ...empty, ...p });
          setCatalog({ projects: c.projects || [], pipelines: c.pipelines || [] });
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [assistantId]);
  usePolling(
    async (signal) => {
      try {
        const r = await api(`/assistants/${encodeURIComponent(assistantId)}/actions`);
        if (!signal.aborted) setActions(r.actions || []);
      } catch (e) {
        if (!signal.aborted) setError(e.message);
      }
    },
    3000,
    { restartKey: assistantId },
  );
  async function act(fn) {
    setBusy(true);
    setError("");
    try {
      await fn();
      setActions(
        (await api(`/assistants/${encodeURIComponent(assistantId)}/actions`)).actions ||
          [],
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function toggle(key, id, enabled) {
    setPolicy((p) => ({
      ...p,
      [key]: enabled ? [...p[key], id] : p[key].filter((x) => x !== id),
    }));
  }
  function save(e) {
    e.preventDefault();
    act(async () => {
      const { revision, projectIds, pipelineIds, memoryWrite, autonomous, publish } =
        policy;
      setPolicy(
        await api(`/assistants/${encodeURIComponent(assistantId)}/access`, "PUT", {
          revision,
          projectIds,
          pipelineIds,
          memoryWrite,
          autonomous,
          publish,
        }),
      );
    });
  }
  return (
    <section className="assistant-form assistant-personal-panel">
      <h2>{copy.title}</h2>
      <p className="assistant-note">{copy.hint}</p>
      <ErrorMessage error={error} />
      {policy && (
        <form onSubmit={save}>
          {["projectIds", "pipelineIds"].map((key) => (
            <fieldset key={key} className="assistant-capability-options">
              <legend>{key === "projectIds" ? copy.projects : copy.pipelines}</legend>
              {catalog[key === "projectIds" ? "projects" : "pipelines"].map((item) => (
                <label key={item.id}>
                  <input
                    disabled={busy}
                    type="checkbox"
                    checked={policy[key].includes(item.id)}
                    onChange={(e) => toggle(key, item.id, e.target.checked)}
                  />
                  {item.name}
                </label>
              ))}
              {!catalog[key === "projectIds" ? "projects" : "pipelines"].length && (
                <p className="assistant-note">{copy.noResources}</p>
              )}
            </fieldset>
          ))}
          <fieldset className="assistant-capability-options">
            <legend>{copy.permissions}</legend>
            {["memoryWrite", "autonomous", "publish"].map((key) => (
              <label key={key}>
                <input
                  disabled={busy}
                  type="checkbox"
                  checked={policy[key]}
                  onChange={(e) => setPolicy((p) => ({ ...p, [key]: e.target.checked }))}
                />
                {copy[key]}
              </label>
            ))}
          </fieldset>
          <p className="assistant-note">{copy.policyHint}</p>
          <button className="button primary" disabled={busy}>
            {copy.save}
          </button>
        </form>
      )}
      <h3>{copy.actions}</h3>
      {!actions.length && <p className="assistant-note">{copy.noActions}</p>}
      {actions
        .slice()
        .reverse()
        .map((a) => (
          <article className="assistant-card assistant-reminder-row" key={a.id}>
            <h3>{a.payload.action === "coding_start" ? copy.coding : copy.memory}</h3>
            {a.requestedBy && <p>{copy.requestedBy(a.memberName)}</p>}
            {a.requestedBy && a.state === "awaiting_approval" && (
              <p className="assistant-note">{copy.memberApprovalHint}</p>
            )}
            <p>
              {a.projectName}
              {a.pipelineName ? ` · ${a.pipelineName}` : ""}
            </p>
            <p>{copy.states[a.state]}</p>
            {a.diagnostic && copy.diagnostics[a.diagnostic] && (
              <p className="assistant-note">{copy.diagnostics[a.diagnostic]}</p>
            )}
            {a.payload.title && <strong>{a.payload.title}</strong>}
            <p className="assistant-memory-text">{a.payload.task || a.payload.content}</p>
            {a.payload.baseBranch && (
              <p>
                {copy.branch}: {a.payload.baseBranch}
              </p>
            )}
            {a.payload.expectedRevision && (
              <p>
                {copy.revision}: {a.payload.expectedRevision}
              </p>
            )}
            {a.run && (
              <>
                <p>
                  {copy.runStatus}: {copy.runStates[a.run.status] || copy.states.unknown}
                </p>
                <a href={a.run.url} className="button secondary">
                  {a.run.status === "awaiting-human" ? copy.humanGate : copy.openRun}
                </a>
                {a.run.nodes?.map((n) => (
                  <p key={n.id}>
                    {n.profileName} · {copy.nodeStates[n.status] || copy.states.running}
                  </p>
                ))}
              </>
            )}
            <div className="assistant-actions">
              {a.state === "awaiting_approval" &&
                ["approve", "decline"].map((decision) => (
                  <button
                    key={decision}
                    disabled={busy}
                    className={`button ${decision === "approve" ? "primary" : "secondary"}`}
                    onClick={() =>
                      act(() =>
                        api(
                          `/assistant-actions/${encodeURIComponent(a.id)}/decision`,
                          "POST",
                          {
                            revision: a.revision,
                            decision,
                          },
                        ),
                      )
                    }
                  >
                    {copy[decision]}
                  </button>
                ))}
              {a.state === "running" && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    act(() =>
                      api(
                        `/assistants/${encodeURIComponent(assistantId)}/actions/${encodeURIComponent(a.id)}/cancel`,
                        "POST",
                        {},
                      ),
                    )
                  }
                >
                  {copy.cancel}
                </button>
              )}
              {a.state === "unknown" && (
                <>
                  <p className="assistant-note">{copy.unknownHint}</p>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      act(() =>
                        api(
                          `/assistant-actions/${encodeURIComponent(a.id)}/decision`,
                          "POST",
                          {
                            revision: a.revision,
                            decision: "review",
                          },
                        ),
                      )
                    }
                  >
                    {copy.review}
                  </button>
                </>
              )}
            </div>
          </article>
        ))}
    </section>
  );
}
