import React from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import api from "../../../lib/api.js";
import { assistantWorkflowCopy as copy } from "../../../lib/i18n/messages/assistant-workflows.js";
import SubpageHeader from "./SubpageHeader.jsx";

const decide = (action, decision) =>
  api(`/assistant-actions/${encodeURIComponent(action.id)}/decision`, "POST", {
    revision: action.revision,
    decision,
  });

function ActionCard({ action: a, assistantId, busy, act }) {
  return (
    <article className="assistant-card assistant-reminder-row">
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
              onClick={() => act(() => decide(a, decision))}
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
              onClick={() => act(() => decide(a, "review"))}
            >
              {copy.review}
            </button>
          </>
        )}
      </div>
    </article>
  );
}

/** "Aktionen und Coding-Aufträge": every action, newest first, with its decisions. */
export default function ActionHistory({ history, assistantId, onBack }) {
  return (
    <section className="agent-subpage" aria-label={copy.actions}>
      <SubpageHeader title={copy.actions} tab="work" onBack={onBack} />
      <ErrorMessage error={history.error} />
      {history.loaded && !history.actions.length && (
        <p className="assistant-note">{copy.noActions}</p>
      )}
      {history.actions
        .slice()
        .reverse()
        .map((action) => (
          <ActionCard
            key={action.id}
            action={action}
            assistantId={assistantId}
            busy={history.busy}
            act={history.act}
          />
        ))}
    </section>
  );
}
