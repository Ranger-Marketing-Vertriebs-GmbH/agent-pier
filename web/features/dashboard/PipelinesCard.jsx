import React from "react";
import Skeleton, { SkeletonLabel } from "../../components/Skeleton.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import { isPlainClick } from "../../components/link-click.js";
import { routePath } from "../../app/routes.js";
import { startPageCopy as copy } from "../../lib/i18n/messages/dashboard.js";
import { runStatusLabel } from "../pipelines/run-codes.js";
import {
  runProgress,
  runProject,
  runStatusTone,
  runUpdatedAt,
} from "../pipelines/run-presentation.js";
import { runTitle } from "../pipelines/run-title.js";
import { runSegments, startRuns } from "./start-agents.js";
import { spanText } from "./SessionsCard.jsx";

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

// "Stage 3 of 5 · Verification · for 18 min"; a failed run says how long ago.
function detail(run) {
  const { done, total, current } = runProgress(run);
  const stage = current?.profileSnapshot?.name || current?.id || "";
  const span = spanText(Date.parse(runUpdatedAt(run) || ""));
  const time =
    !span || span === copy.span.now
      ? span
      : run.status === "failed"
        ? copy.ago(span)
        : copy.since(span);
  return [total ? copy.runStage(Math.min(done + 1, total), total) : "", stage, time]
    .filter(Boolean)
    .join(" · ");
}

// Skeleton runs in the shape of the run rows.
function SkeletonRuns({ count }) {
  return (
    <ul className="start-runs">
      {Array.from({ length: count }, (_, index) => (
        <li key={index}>
          <span className="start-run">
            <span className="start-run-head">
              <strong>
                <Skeleton width="11em" />
              </strong>
              <span className="status-chip">
                <Skeleton width="4.5em" />
              </span>
            </span>
            <span className="start-run-bar" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <small>
              <Skeleton width="13em" />
            </small>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Up to three runs (running, awaiting a decision, failed) with their stages as a
 * segmented bar, and All runs. `runs` are the first pages the menu hint sources read;
 * null while unknown, when `shape` skeleton runs (the remembered number) hold their
 * place. Phones show a summary tile that links to Pipelines; `loading` while its
 * counts are unknown.
 */
export default function PipelinesCard({
  runs,
  counts,
  navigate,
  phone,
  shape = 1,
  loading = false,
}) {
  const picked = startRuns(runs);
  if (phone)
    return (
      <Link route={allRuns} navigate={navigate} className="start-card start-tile">
        <strong>{copy.pipelines}</strong>
        {loading ? (
          <small aria-busy="true">
            <SkeletonLabel />
            {/* The counts often take two lines in the narrow tile. */}
            <Skeleton width="90%" />
            <Skeleton width="50%" />
          </small>
        ) : (
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
        )}
      </Link>
    );
  return (
    <section
      className="start-card start-pipelines"
      aria-labelledby="start-pipelines-title"
      aria-busy={picked === null || undefined}
    >
      <div className="start-card-head">
        <h2 id="start-pipelines-title">{copy.pipelines}</h2>
        <Link route={allRuns} navigate={navigate} className="start-head-link">
          {copy.allRuns}
        </Link>
      </div>
      {picked === null ? (
        <>
          <SkeletonLabel />
          {shape > 0 ? (
            <SkeletonRuns count={Math.min(shape, 3)} />
          ) : (
            <p className="start-empty">
              <Skeleton width="60%" />
            </p>
          )}
        </>
      ) : picked.length === 0 ? (
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
