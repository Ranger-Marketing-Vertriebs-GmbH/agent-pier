import React from "react";
import Icon from "../../components/Icon.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import { chipTone } from "../../components/status-tones.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { Findings } from "./Verdict.jsx";
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

// The repair turn's answer to one finding, once the repair has delivered its verdict.
function answerText(round) {
  if (!round.repairAttemptId && !round.responses?.length) return undefined;
  const answers = new Map((round.responses || []).map((r) => [r.finding, r]));
  return (finding) => {
    const response = answers.get(finding.id);
    if (!response) return copy.roundUnanswered;
    return copy.roundAnswer(
      copy.roundAnswers[response.status] || response.status,
      response.reason,
    );
  };
}

// The loop rounds of a run as a timeline, oldest first: which stage sent the run back
// to which, how many findings the round held and how the repair turn answered them.
// A round with findings opens to list them with their answers.
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
          const findings = stages.flatMap((stage) => stage.findings || []);
          const failed = stages.some((stage) => stage.result === "fail");
          const answers = answerCounts(round.responses);
          const row = (
            <>
              <StatusDot
                tone={chipTone(failed ? "error" : "ok")}
                label={failed ? copy.fail : copy.pass}
                className="run-dot"
              />
              <strong>{copy.roundNumber(round.round)}</strong>
              <span>{copy.roundPath(name(round.fromNodeId), name(round.toNodeId))}</span>
              <span>{`${copy.findings} · ${findings.length}`}</span>
              {answers && <span>{answers}</span>}
              <small>{formatTimestamp(round.at)}</small>
            </>
          );
          return (
            <li key={`${round.edge}-${round.round}`}>
              {findings.length ? (
                <details className="run-round">
                  <summary>
                    <Icon name="chevron" size={14} className="run-round-chevron" />
                    {row}
                  </summary>
                  <Findings findings={findings} answer={answerText(round)} />
                </details>
              ) : (
                row
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
