import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { memoryReviewCopy as copy } from "../../lib/i18n/messages/assistant-memory-reviews.js";
import MemoryReviewCard from "./MemoryReviewCard.jsx";
import useMemoryReviews from "./useMemoryReviews.js";

// The memory review cards that belong in this chat (the owner's main chat of the
// switched agent or of its lead), and what the last Apply did.
export default function MemoryReviews({ conversationId }) {
  const { reviews, error, reload } = useMemoryReviews();
  const [applied, setApplied] = useState(null);
  const own = reviews.filter((r) => r.conversationId === conversationId);
  if (!own.length && !applied && !error) return null;
  return (
    <section className="assistant-team-approvals" aria-label={copy.title}>
      {own.length > 0 && <ErrorMessage error={error} />}
      {applied && (
        <p className="assistant-note" role="status" data-memory-review-applied="">
          {copy.applied(applied.archived, applied.kept, applied.changed)}
        </p>
      )}
      {own.map((review) => (
        <MemoryReviewCard
          key={`${review.id}:${review.revision}`}
          review={review}
          onApplied={async (result) => {
            setApplied(result);
            await reload();
          }}
        />
      ))}
    </section>
  );
}
