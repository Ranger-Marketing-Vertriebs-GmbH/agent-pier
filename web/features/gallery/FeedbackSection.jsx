import React from "react";
import ActivityGroup from "../../components/ActivityGroup.jsx";
import ActivityRow from "../../components/ActivityRow.jsx";
import CodeBlock from "../../components/CodeBlock.jsx";
import CopyButton from "../../components/CopyButton.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import HistoryChart from "../../components/HistoryChart.jsx";
import LearnMore from "../../components/LearnMore.jsx";
import { Pagination, usePagination } from "../../components/Pagination.jsx";
import ShareBar from "../../components/ShareBar.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import { galleryCopy as copy } from "../../lib/i18n/messages/gallery.js";
import { GallerySection, Specimen } from "./GallerySection.jsx";
import { historySample, pageItems } from "./gallery-fixtures.js";
import { formatNumber, locale } from "../../lib/i18n/index.js";

// The chart's sample hour ends when the gallery opens.
const end = Date.now();
const percent = (value) =>
  Number.isFinite(value)
    ? formatNumber(value / 100, { style: "percent", maximumFractionDigits: 0 })
    : "–";
const clock = (value) =>
  new Date(value).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

const dotTones = [
  "working",
  "waiting",
  "ok",
  "error",
  "warning",
  "idle",
  "pending",
  "unknown",
];
const tones = ["ok", "error", "neutral", "pending", "running", "waiting"];
const chipText = {
  ok: "chipOk",
  error: "chipError",
  neutral: "chipNeutral",
  pending: "chipPending",
  running: "chipRunning",
  waiting: "chipWaiting",
};

export default function FeedbackSection() {
  const s = copy.sample;
  const paging = usePagination(pageItems());
  return (
    <GallerySection id="feedback">
      <Specimen label="StatusDot" wide>
        <ul className="gallery-dots">
          {dotTones.map((tone) => (
            <li key={tone}>
              <StatusDot tone={tone} pulse={tone === "working"} />
              <code>{tone}</code>
            </li>
          ))}
        </ul>
      </Specimen>
      <Specimen label="StatusChip" wide>
        {tones.map((tone) => (
          <StatusChip key={tone} tone={tone}>
            {s[chipText[tone]]}
          </StatusChip>
        ))}
        <StatusChip tone="decision">{s.chipDecision}</StatusChip>
        <StatusChip tone="ok" pill>
          {s.chipOk}
        </StatusChip>
      </Specimen>
      <Specimen label="ErrorMessage" wide>
        <ErrorMessage error={s.error} />
      </Specimen>
      <Specimen label="LearnMore" wide>
        <LearnMore hint={s.learnMoreHint}>
          <p>{s.learnMoreBody}</p>
        </LearnMore>
      </Specimen>
      <Specimen label="CopyButton">
        <CopyButton text={s.code} label={s.copyLabel} />
        <CopyButton text={s.code} label={s.copyLabel} iconOnly className="icon-button" />
      </Specimen>
      <Specimen label="CodeBlock" wide>
        <CodeBlock>
          <code>{s.code}</code>
        </CodeBlock>
      </Specimen>
      <Specimen label="ActivityRow" wide>
        <ActivityRow
          label={s.activityLabel}
          detail={s.activityCommand}
          status={s.chipOk}
          tone="ok"
          defaultOpen
        >
          <CodeBlock className="activity-row-code" copyText={s.activityCommand}>
            <code>{s.activityCommand}</code>
          </CodeBlock>
        </ActivityRow>
        <ActivityRow
          label={s.activityLabel}
          detail={s.activityCommand}
          status={s.chipError}
          tone="error"
        >
          <p className="activity-row-note">{s.activityBody}</p>
        </ActivityRow>
      </Specimen>
      <Specimen label="ActivityGroup" wide>
        <ActivityGroup count={3} summary={s.activityHost} failed={1}>
          {[s.chipOk, s.chipError, s.chipOk].map((status, index) => (
            <ActivityRow
              key={index}
              label={s.activityLabel}
              detail={s.activityCommand}
              status={status}
              tone={status === s.chipOk ? "ok" : "error"}
            >
              <p className="activity-row-note">{s.activityBody}</p>
            </ActivityRow>
          ))}
        </ActivityGroup>
      </Specimen>
      <Specimen label="HistoryChart" wide>
        <HistoryChart
          label={s.chartLabel}
          heading={<strong>{s.chartHeading}</strong>}
          series={[
            { id: "first", label: s.chartFirst, field: "first", tone: "cpu" },
            { id: "second", label: s.chartSecond, field: "second", tone: "memory" },
            {
              id: "third",
              label: s.chartThird,
              field: "third",
              tone: "agentpier",
              dashed: true,
            },
          ]}
          points={historySample(end)}
          start={end - 60 * 60_000}
          end={end}
          xLabels={[60, 30, 0].map((minutes) => ({
            at: end - minutes * 60_000,
            label: minutes ? s.chartAgo(minutes) : s.chartNow,
          }))}
          formatValue={percent}
          formatTime={clock}
          timeLabel={s.chartTime}
        />
      </Specimen>
      <Specimen label="ShareBar" wide>
        <ShareBar
          label={s.shareLabel}
          total={100}
          segments={[
            { id: "own", label: s.shareOwn, value: 6, tone: "cpu", text: percent(6) },
            {
              id: "other",
              label: s.shareOther,
              value: 12,
              tone: "other",
              text: percent(12),
            },
            {
              id: "free",
              label: s.shareFree,
              value: 82,
              tone: "free",
              text: percent(82),
            },
          ]}
        />
      </Specimen>
      <Specimen label="Pagination" wide>
        <Pagination paging={paging} label={s.pagination} />
      </Specimen>
    </GallerySection>
  );
}
