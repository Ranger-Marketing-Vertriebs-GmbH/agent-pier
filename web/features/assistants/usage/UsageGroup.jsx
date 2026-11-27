import React, { useId } from "react";
import CapabilityGate from "../../../components/CapabilityGate.jsx";
import { capabilityOf } from "../../../components/capability-gate.js";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../../components/ListRow.jsx";
import ValueChart from "../../../components/ValueChart.jsx";
import { locale } from "../../../lib/i18n/index.js";
import { assistantUsageCopy as copy } from "../../../lib/i18n/messages/assistant-usage.js";
import useLiveTopic from "../../../lib/live/useLiveTopic.js";
import { formatTokens } from "../../chat/token-presentation.js";
import { costText, dailyPoints, hasUsage, tokensText } from "./usage-presentation.js";
import "./agent-usage.css";

const periodIds = ["today", "week", "month"];
// "2026-11-27" as a short date of the reader's language; the day is a calendar day,
// so it is read at noon and never shifts with the time zone.
const shortDay = (date) =>
  new Date(`${date}T12:00:00`).toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
  });

/**
 * Usage (docs/agents.md "Usage"): what all of the agent's sessions used today and
 * over the last 7 and 30 days, as tokens and, where the model has a price, cost, with
 * the tokens per day of the last 30 days. The live topic `agent.usage:<id>` pushes it
 * after each finished turn. A runtime that records no usage keeps the group, disabled
 * with the reason (CapabilityGate).
 */
export default function UsageGroup({ assistant }) {
  const id = useId();
  const offered = capabilityOf(assistant.runtimeInfo, "usage").available;
  const topic = useLiveTopic(offered ? `agent.usage:${assistant.id}` : null);
  const usage = topic.data;
  const periods = new Map((usage?.periods || []).map((period) => [period.id, period]));
  const points = dailyPoints(usage?.daily, shortDay);
  return (
    <section id="agent-usage" aria-labelledby={id}>
      <GroupLabel id={id} hint={copy.hint}>
        {copy.title}
      </GroupLabel>
      <CapabilityGate runtime={assistant.runtimeInfo} capability="usage">
        {!usage && topic.error && <ErrorMessage error={copy.unavailable} />}
        <ListCard labelledBy={id}>
          {periodIds.map((periodId) => {
            const period = periods.get(periodId);
            return (
              <ListRow
                key={periodId}
                className="agent-usage-row"
                label={copy.periods[periodId]}
                sub={
                  period
                    ? [tokensText(period), period.pending ? copy.pending : ""]
                        .filter(Boolean)
                        .join(" · ")
                    : undefined
                }
                value={period ? costText(period) : unknownValue}
              />
            );
          })}
        </ListCard>
        {hasUsage(periods.get("month")) && points.length > 1 && (
          <ValueChart
            kind="bar"
            className="agent-usage-chart"
            points={points}
            label={copy.chart}
            formatValue={(value) => formatTokens(Math.round(value)) ?? "0"}
          />
        )}
      </CapabilityGate>
    </section>
  );
}
