import React from "react";
import Icon from "../../../components/Icon.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import { assistantDreamingCopy as copy } from "../../../lib/i18n/messages/assistant-dreaming.js";
import {
  charsOf,
  entriesOf,
  pinMarker,
  pinnedCharsOf,
  togglePin,
} from "./memory-pins.js";

const labelLength = 120;
// An entry's first line, without its marker, as plain text.
const labelOf = (entry) => {
  const line = (entry.startsWith(pinMarker) ? entry.slice(pinMarker.length) : entry)
    .trim()
    .split("\n")[0];
  const points = [...line];
  return points.length > labelLength ? `${points.slice(0, labelLength).join("")}…` : line;
};

/**
 * The entries of a Hermes memory file (`text`, the draft) with a pin each, and how much
 * of its `limit` the file and its pinned entries take. A pin edits the text through
 * `onChange`; the memory page saves it like any other edit.
 */
export default function MemoryPins({ text, limit, readOnly = false, onChange }) {
  const entries = entriesOf(text);
  return (
    <>
      {entries.length > 0 && (
        <ListCard label={copy.entries}>
          {entries.map((entry, index) => {
            const pinned = entry.startsWith(pinMarker);
            const n = index + 1;
            return (
              <ListRow
                key={index}
                label={labelOf(entry)}
                value={pinned ? copy.pinned : undefined}
              >
                <button
                  type="button"
                  className="icon-button"
                  aria-label={pinned ? copy.unpin(n) : copy.pin(n)}
                  aria-pressed={pinned}
                  disabled={readOnly}
                  onClick={() => onChange(togglePin(text, index))}
                >
                  <Icon name="pin" />
                </button>
              </ListRow>
            );
          })}
        </ListCard>
      )}
      <p className="assistant-note">
        {copy.room(charsOf(text), limit, pinnedCharsOf(text))}
      </p>
      <p className="assistant-note">{copy.pinsHint}</p>
    </>
  );
}
