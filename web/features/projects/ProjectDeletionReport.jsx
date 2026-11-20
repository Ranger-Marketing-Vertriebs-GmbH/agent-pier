import React, { useId } from "react";
import Checkbox from "../../components/Checkbox.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { projectDeletionCopy as copy } from "../../lib/i18n/messages/project-deletion.js";
import { endableProcesses, gitWarnings, refusalText } from "./project-deletion.js";

function Section({ title, tone = "", children }) {
  const id = useId();
  return (
    <section className={`project-deletion-section ${tone}`} aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {children}
    </section>
  );
}

function blockerLines(blockers) {
  const queued = blockers.queue?.length ?? 0;
  return [
    ...(blockers.sessions ?? []).map((item) => ({
      id: `session:${item.id}`,
      text: item.name || item.id,
    })),
    ...(blockers.runs ?? []).map((item) => ({
      id: `run:${item.id}`,
      text: copy.blockerRun(item.pipelineName || item.id),
    })),
    ...(queued ? [{ id: "queue", text: copy.blockerQueued(queued) }] : []),
    ...(blockers.rebuilds ?? []).map((item) => ({
      id: `rebuild:${item.id}`,
      text: copy.blockerRebuild(item.name || item.id),
    })),
  ];
}

// A session's processes are listed as that session among the blockers, never here.
const knownLabel = (item) =>
  item.known?.kind === "agent-command" ? copy.knownAgentCommand : "";

/**
 * The preflight report in the delete dialog: a refusal, what blocks (running work
 * with "Stop sessions", processes using the folder with a box per endable one), the
 * unsaved Git work that is lost, nested projects deleted with it, and who has
 * access. `ticked` maps a ticked pid to the start time the report showed.
 */
export default function ProjectDeletionReport({
  report,
  ticked,
  onTick,
  onStopSessions,
  onEndProcesses,
  onRescan,
  busy,
}) {
  const blocked = blockerLines(report.blockers ?? {});
  const processes = report.processes ?? { status: "skipped", list: [] };
  const scanFailed = ["timeout", "failed"].includes(processes.status);
  const endable = endableProcesses(report);
  const tickedCount = endable.filter((item) => ticked.has(item.pid)).length;
  const git = gitWarnings(report);
  const nested = (report.projects ?? []).filter((item) => !item.main);
  const agents = report.access?.agents ?? [];
  const users = report.access?.users ?? [];
  return (
    <div className="project-deletion-report">
      {report.refused && <ErrorMessage error={refusalText(report.refused)} />}
      {blocked.length > 0 && (
        <Section title={copy.blockersTitle} tone="blocking">
          <ul>
            {blocked.map((line) => (
              <li key={line.id}>{line.text}</li>
            ))}
          </ul>
          <p className="field-description">{copy.blockersNote}</p>
          <div className="project-deletion-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={onStopSessions}
            >
              {copy.stopSessions}
            </button>
          </div>
        </Section>
      )}
      {(processes.list.length > 0 || scanFailed) && (
        <Section title={copy.processesTitle} tone="blocking">
          {scanFailed && <p className="project-deletion-warning">{copy.scanTimeout}</p>}
          {processes.list.length > 0 && (
            <ul className="project-deletion-processes">
              {processes.list.map((item) => {
                const label = copy.processLabel(item.name || "?", item.pid);
                const known = knownLabel(item);
                return (
                  <li key={item.pid}>
                    {item.endable ? (
                      <Checkbox
                        label={label}
                        checked={ticked.has(item.pid)}
                        disabled={busy}
                        onChange={(on) => onTick(item, on)}
                      />
                    ) : (
                      <span>{label}</span>
                    )}
                    {known && <small>{known}</small>}
                    {item.protected ? (
                      <small>{copy.processProtected}</small>
                    ) : (
                      item.owner === "other" && <small>{copy.processOther}</small>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {endable.length > 0 && (
            <div className="project-deletion-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy || tickedCount === 0}
                onClick={onEndProcesses}
              >
                {copy.endProcesses}
              </button>
            </div>
          )}
        </Section>
      )}
      {!report.ready && (
        <div className="project-deletion-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onRescan}
          >
            {copy.rescan}
          </button>
        </div>
      )}
      {git.length > 0 && (
        <Section title={copy.gitTitle} tone="warning">
          <ul>
            {git.map((line) => (
              <li key={line.id}>
                {line.named ? (
                  line.text
                ) : (
                  <>
                    <code>{line.path}</code> {line.text}
                  </>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {nested.length > 0 && (
        <Section title={copy.nestedTitle}>
          <ul>
            {nested.map((item) => (
              <li key={item.path}>
                {item.name} <code>{item.path}</code>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {(agents.length > 0 || users.length > 0) && (
        <Section title={copy.accessTitle}>
          {agents.length > 0 && (
            <p>{copy.accessAgents(agents.map((item) => item.name).join(", "))}</p>
          )}
          {users.length > 0 && (
            <p>{copy.accessUsers(users.map((item) => item.name).join(", "))}</p>
          )}
          <p className="field-description">{copy.accessNote}</p>
        </Section>
      )}
    </div>
  );
}
