import React from "react";
import CodeBlock from "../../components/CodeBlock.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import LearnMore from "../../components/LearnMore.jsx";
import { Pagination, usePagination } from "../../components/Pagination.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import { galleryCopy as copy } from "../../lib/i18n/messages/gallery.js";
import { GallerySection, Specimen } from "./GallerySection.jsx";
import { pageItems } from "./gallery-fixtures.js";

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
      <Specimen label="CodeBlock" wide>
        <CodeBlock>
          <code>{s.code}</code>
        </CodeBlock>
      </Specimen>
      <Specimen label="Pagination" wide>
        <Pagination paging={paging} label={s.pagination} />
      </Specimen>
    </GallerySection>
  );
}
