import React from "react";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { runProgress } from "./run-presentation.js";
import { cliName, stageFlags, stageName, stageStatus, stageTone } from "./run-stages.js";

// Stage list of a run: progress caption, then one button per stage with its number in
// the status colour, profile, "CLI · status" and the flags taken from the run graph.
export default function StageRail({ run, selectedId, onSelect }) {
  const progress = runProgress(run);
  return (
    <div className="run-stage-rail">
      <span className="run-caps run-stage-progress">
        {copy.runStageProgress(progress.done, progress.total)}
      </span>
      <nav aria-label={copy.stages}>
        <ol>
          {run.nodes.map((node, index) => {
            const flags = stageFlags(run, node);
            const tool = cliName(node.profileSnapshot?.config?.cliTool);
            return (
              <li key={node.id}>
                <button
                  type="button"
                  className="run-stage-button"
                  aria-current={node.id === selectedId ? "step" : undefined}
                  onClick={() => onSelect(node.id)}
                >
                  <span
                    className={`run-stage-number tone-${stageTone(run, node)}`}
                    aria-hidden="true"
                  >
                    {index + 1}
                  </span>
                  <span className="run-stage-text">
                    <strong>{stageName(node)}</strong>
                    <small>
                      {tool ? `${tool} · ` : ""}
                      {stageStatus(run, node)}
                    </small>
                    {flags.length > 0 && (
                      <span className="run-stage-flags">
                        {flags.map((flag) => (
                          <span key={flag.key} className="run-stage-flag">
                            {flag.label}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
    </div>
  );
}
