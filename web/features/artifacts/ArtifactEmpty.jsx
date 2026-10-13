import React from "react";
import { InfoHintText, useInfoHint } from "../../components/InfoHint.jsx";
import { artifactCopy as copy } from "../../lib/i18n/messages/artifacts.js";

/** Short empty states with one action each: filters, the Pinned tab, or none at all. */
export default function ArtifactEmpty({ term, filtered, pinned, onClear }) {
  const info = useInfoHint();
  if (filtered)
    return (
      <div className="artifacts-empty">
        <p>{term ? copy.emptySearch(term) : copy.emptyFilter}</p>
        <button type="button" className="button secondary" onClick={onClear}>
          {copy.clearFilters}
        </button>
      </div>
    );
  if (pinned)
    return (
      <div className="artifacts-empty">
        <p>{copy.emptyPinned}</p>
      </div>
    );
  return (
    <div className="artifacts-empty">
      <p>{copy.emptyNone}</p>
      <button
        type="button"
        className="button secondary"
        aria-expanded={info.open}
        aria-controls={info.id}
        onClick={info.toggle}
      >
        {copy.howPublishing}
      </button>
      <InfoHintText hint={info}>{copy.howPublishingText}</InfoHintText>
    </div>
  );
}
