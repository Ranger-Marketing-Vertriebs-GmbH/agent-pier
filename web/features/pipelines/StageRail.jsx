import React from "react";
import StatusDot from "../../components/StatusDot.jsx";
import { chipTone } from "../../components/status-tones.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { runProgress } from "./run-presentation.js";
import {
  cliName,
  groupMembers,
  memberStatus,
  memberTone,
  railNodes,
  stageFlags,
  stageName,
  stageStatus,
  stageTone,
} from "./run-stages.js";

// The live verdict chips of a parallel group's members, side by side; each opens its
// member.
export function MemberChips({ run, group, selectedId, onSelect }) {
  return (
    <ul className="run-member-chips" aria-label={copy.groupMembers}>
      {groupMembers(run, group).map((member) => (
        <li key={member.id}>
          <button
            type="button"
            className="run-member-chip"
            aria-current={member.id === selectedId ? "step" : undefined}
            onClick={() => onSelect(member.id)}
          >
            <StatusDot tone={chipTone(memberTone(run, member))} className="run-dot" />
            <span>
              {stageName(member)} · {memberStatus(run, member)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// Stage list of a run: progress caption, then one button per stage with its number in
// the status colour, profile, "CLI · status" and the flags taken from the run graph.
// A parallel group is one stage with its members' chips below it.
export default function StageRail({ run, selectedId, onSelect }) {
  const progress = runProgress(run);
  return (
    <div className="run-stage-rail">
      <span className="run-caps run-stage-progress">
        {copy.runStageProgress(progress.done, progress.total)}
      </span>
      <nav aria-label={copy.stages}>
        <ol>
          {railNodes(run).map((node, index) => {
            const flags = stageFlags(run, node);
            const tool = cliName(node.profileSnapshot?.config?.cliTool);
            const group = node.kind === "parallel";
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
                    <strong>{group ? copy.parallelGroup : stageName(node)}</strong>
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
                {group && (
                  <MemberChips
                    run={run}
                    group={node}
                    selectedId={selectedId}
                    onSelect={onSelect}
                  />
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    </div>
  );
}
