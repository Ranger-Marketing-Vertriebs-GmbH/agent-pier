import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import Segment from "../../components/Segment.jsx";
import { memoryReviewCopy as copy } from "../../lib/i18n/messages/assistant-memory-reviews.js";
import { assistantApi } from "./assistant-api.js";

const entriesOf = (review) => review.agents.flatMap((a) => a.entries);

/**
 * The owner's card after a model switch's memory review: per agent the entries an
 * earlier model wrote about its own refusals or limits, each with its file and the
 * choice Archive (the default) or Keep, then **Apply**. Shown in the owner's main
 * chat of the agent (of its lead for a member) and in the inbox until applied.
 * `onApplied(result)` gets `{ archived, kept, changed }`.
 */
export default function MemoryReviewCard({ review, onApplied }) {
  const [choices, setChoices] = useState(() =>
    // Every entry on the card is a model limit: Archive is preselected.
    Object.fromEntries(entriesOf(review).map((e) => [e.id, "archive"])),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const options = [
    { value: "archive", label: copy.archive },
    { value: "keep", label: copy.keep },
  ];
  async function apply() {
    setBusy(true);
    setError("");
    try {
      const result = await assistantApi.decideMemoryReview(review.id, {
        revision: review.revision,
        choices,
      });
      await onApplied?.(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article
      id={`memory-review-${review.id}`}
      className="assistant-approval-card"
      data-pending=""
      data-memory-review=""
      aria-label={copy.title}
    >
      <div className="assistant-approval-head">
        <strong>{copy.title}</strong>
        {review.switch && (
          <small>{copy.switched(review.switch.from, review.switch.to)}</small>
        )}
      </div>
      <p className="assistant-note">{copy.hint}</p>
      {review.agents.map((agent) => (
        <section key={agent.assistantId} data-memory-review-agent={agent.assistantId}>
          <GroupLabel as="h3">
            {agent.name} · {copy.entries(agent.entries.length)}
          </GroupLabel>
          <ListCard label={agent.name}>
            {agent.entries.map((entry) => (
              <ListRow
                key={entry.id}
                label={entry.entry}
                sub={entry.file}
                className="memory-review-entry"
              >
                <Segment
                  label={copy.choice(entry.file)}
                  options={options}
                  value={choices[entry.id]}
                  disabled={busy}
                  onChange={(value) =>
                    setChoices((current) => ({ ...current, [entry.id]: value }))
                  }
                />
              </ListRow>
            ))}
          </ListCard>
        </section>
      ))}
      <ErrorMessage error={error} />
      <div className="assistant-card-actions">
        <button type="button" className="button primary" disabled={busy} onClick={apply}>
          {copy.apply}
        </button>
      </div>
    </article>
  );
}
