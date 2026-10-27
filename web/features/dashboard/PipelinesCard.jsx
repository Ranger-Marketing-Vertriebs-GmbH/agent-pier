import React from "react";
import StatusChip from "../../components/StatusChip.jsx";
import { isPlainClick } from "../../components/link-click.js";
import { routePath } from "../../app/routes.js";
import { startPageCopy as copy } from "../../lib/i18n/messages/dashboard.js";
import { runStatusLabel } from "../pipelines/run-codes.js";
import { runProgress, runProject, runStatusTone } from "../pipelines/run-presentation.js";
import { runTitle } from "../pipelines/run-title.js";
import { runSegments, startRuns } from "./start-agents.js";

const allRuns = { view: "pipelines" };
const runRoute = (id) => ({ view: "pipelines", pipelineTab: "runs", pipelineItem: id });

function Link({ route, navigate, className, children }) {
  return (
    <a
      className={className}
      href={routePath(route)}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        navigate(route);
      }}
    >
      {children}
    </a>
  );
}

function detail(run) {
  const { done, total, current } = runProgress(run);
  const stage = current?.profileSnapshot?.name || current?.id || "";
  return [total ? copy.runStage(Math.min(done + 1, total), total) : "", stage]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Up to three runs (running, awaiting a decision, failed) with their stages as a
 * segmented bar, and All runs. `runs` are the first pages the menu hint sources read;
 * null while unknown. Phones show a summary tile that links to Pipelines.
 */
export default function PipelinesCard({ runs, counts, navigate, phone }) {
  const picked = startRuns(runs);
  if (phone)
    return (
      <Link route={allRuns} navigate={navigate} className="start-card start-tile">
        <strong>{copy.pipelines}</strong>
        <small>
          {[
            counts.running > 0 && copy.runsSummary.running(counts.running),
            counts.decisions > 0 && (
              <span key="d" className="start-warn">
                {copy.runsSummary.decisions(counts.decisions)}
              </span>
            ),
            counts.failed > 0 && (
              <span key="f" className="start-warn">
                {copy.runsSummary.failed(counts.failed)}
              </span>
            ),
          ]
            .filter(Boolean)
            .flatMap((part, index) => (index ? [" · ", part] : [part]))}
          {!counts.running && !counts.decisions && !counts.failed && copy.allRuns}
        </small>
      </Link>
    );
  return (
    <section
      className="start-card start-pipelines"
      aria-labelledby="start-pipelines-title"
    >
      <div className="start-card-head">
        <h2 id="start-pipelines-title">{copy.pipelines}</h2>
        <Link route={allRuns} navigate={navigate} className="start-head-link">
          {copy.allRuns}
        </Link>
      </div>
      {picked === null ? null : picked.length === 0 ? (
        <p className="start-empty">{copy.noRuns}</p>
      ) : (
        <ul className="start-runs">
          {picked.map((run) => {
            const project = runProject(run);
            const title = runTitle(run);
            return (
              <li key={run.id}>
                <Link route={runRoute(run.id)} navigate={navigate} className="start-run">
                  <span className="start-run-head">
                    <strong>{[project, title].filter(Boolean).join(" · ")}</strong>
                    <StatusChip tone={runStatusTone(run.status)}>
                      {runStatusLabel(run.status)}
                    </StatusChip>
                  </span>
                  <span className="start-run-bar" aria-hidden="true">
                    {runSegments(run).map((segment) => (
                      <i
                        key={segment.id}
                        className={`${segment.state} ${segment.state === "current" ? run.status : ""}`}
                      />
                    ))}
                  </span>
                  <small>{detail(run)}</small>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
