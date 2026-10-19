import React from "react";
import StatusDot from "../../components/StatusDot.jsx";
import { chipTone } from "../../components/status-tones.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { stageName } from "./run-stages.js";

// Answer counts of a repair turn, e.g. "Fixed 2 · Disputed 1".
function answerCounts(responses) {
  const counts = new Map();
  for (const response of responses || [])
    counts.set(response.status, (counts.get(response.status) || 0) + 1);
  return Object.keys(copy.roundAnswers)
    .filter((status) => counts.has(status))
    .map((status) => `${copy.roundAnswers[status]} ${counts.get(status)}`)
    .join(" · ");
}

// The loop rounds of a run as a timeline, oldest first: which stage sent the run back
// to which, how many findings the round held and how the repair turn answered them.
export default function LoopRounds({ run }) {
  const rounds = Array.isArray(run.loopRounds) ? run.loopRounds : [];
  if (!rounds.length) return null;
  const name = (id) => {
    const node = run.nodes?.find((item) => item.id === id);
    return node ? stageName(node) : id;
  };
  return (
    <section className="run-stage-block" aria-labelledby="run-rounds-title">
      <span className="run-caps" id="run-rounds-title">
        {copy.rounds}
      </span>
      <ol className="run-stage-history run-rounds">
        {rounds.map((round) => {
          const stages = Array.isArray(round.stages) ? round.stages : [];
          const findings = stages.reduce(
            (sum, stage) => sum + (stage.findings?.length || 0),
            0,
          );
          const failed = stages.some((stage) => stage.result === "fail");
          const answers = answerCounts(round.responses);
          return (
            <li key={`${round.edge}-${round.round}`}>
              <StatusDot tone={chipTone(failed ? "error" : "ok")} className="run-dot" />
              <strong>{copy.roundNumber(round.round)}</strong>
              <span>{copy.roundPath(name(round.fromNodeId), name(round.toNodeId))}</span>
              <span>{`${copy.findings} · ${findings}`}</span>
              {answers && <span>{answers}</span>}
              <small>{formatTimestamp(round.at)}</small>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
