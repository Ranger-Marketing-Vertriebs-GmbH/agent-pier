import React from "react";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { formatNumber } from "../../lib/i18n/index.js";

// The usage the run reported across all stages; the heading says so, because it is shown
// beside each stage and also for runs without stages. A run with a token budget shows
// its total against that budget.
export default function RunUsage({ usage, budget }) {
  if (!usage && !budget) return null;
  const value = (key) => (Number.isFinite(usage?.[key]) ? formatNumber(usage[key]) : "–");
  return (
    <section className="run-stage-block run-usage-block">
      <h4>{copy.usageWholeRun}</h4>
      <div
        className={budget ? "run-usage run-usage-budget" : "run-usage"}
        role="group"
        aria-label={copy.usage}
      >
        {[
          [copy.input, value("inputTokens")],
          [copy.output, value("outputTokens")],
          [copy.total, value("totalTokens")],
          ...(budget
            ? [
                [
                  copy.budget,
                  copy.budgetUsage(
                    formatNumber(usage?.totalTokens || 0),
                    formatNumber(budget),
                  ),
                ],
              ]
            : []),
          [copy.cost, Number.isFinite(usage?.costUsd) ? `${usage.costUsd} USD` : "–"],
        ].map(([label, text]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{text}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}
