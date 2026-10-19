import React from "react";
import Icon from "../../components/Icon.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import { chipTone } from "../../components/status-tones.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { formatNumber, formatTimestamp } from "../../lib/i18n/index.js";
import { Findings } from "./Verdict.jsx";
import { stageName } from "./run-stages.js";
import { repairSessionLabel, tokenTotal } from "./run-codes.js";

// The repair of a round: how its session ran, and the tokens of every turn it took,
// including a resumed turn that fell back to a new session.
function roundRepair(run, round) {
  const log = Array.isArray(run.executionLog) ? run.executionLog : [];
  const opened = log.filter(
    (entry) =>
      entry.nodeId === round.toNodeId &&
      entry.repair?.edge === round.edge &&
      entry.repair?.round === round.round,
  );
  if (!opened.length) return "";
  const attempts = new Set(opened.map((entry) => entry.attemptId));
  const totals = log
    .filter((entry) => attempts.has(entry.attemptId))
    .map((entry) => tokenTotal(entry.usage))
    .filter((total) => total !== null);
  const session = repairSessionLabel(opened.at(-1).repair);
  return totals.length
    ? `${session} · ${copy.tokenCount(formatNumber(totals.reduce((a, b) => a + b, 0)))}`
    : session;
}

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

// The repair turn's answer to one finding. A finding without an answer is unanswered once
// the repair delivered its verdict, and pending while the repair of the newest round
// into its stage may still answer it.
function answerText(round, pending) {
  const answers = new Map((round.responses || []).map((r) => [r.finding, r]));
  return (finding) => {
    const response = answers.get(finding.id);
    if (!response)
      return round.repairAttemptId
        ? copy.roundUnanswered
        : pending
          ? copy.roundAnswerPending
          : undefined;
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
  const live = !["completed", "failed", "cancelled"].includes(run.status);
  const newest = (round) =>
    rounds.findLast((item) => item.toNodeId === round.toNodeId) === round;
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
          const repair = roundRepair(run, round);
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
              {repair && <span>{repair}</span>}
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
                  <Findings
                    findings={findings}
                    answer={answerText(round, live && newest(round))}
                  />
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
