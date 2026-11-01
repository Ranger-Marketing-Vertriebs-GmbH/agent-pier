import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import api from "../../lib/api.js";
import { previewCopy as copy } from "../../lib/i18n/messages/previews.js";
import { previewHref } from "./preview-links.js";

/**
 * Previews as rows: label, "Port <target>" (plus the owner's name when `ownerName`
 * gives one), an Open preview link in a new tab and, with `onStop`, a Stop button.
 * `onStop(preview)` runs after the server closed the preview.
 */
export default function PreviewRows({ previews, onStop, ownerName, label }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const stop = async (preview) => {
    setBusy(preview.id);
    setError("");
    try {
      await api(`/previews/${encodeURIComponent(preview.id)}`, "DELETE");
      await onStop?.(preview);
    } catch (reason) {
      setError(reason?.message || String(reason));
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      <ErrorMessage error={error} />
      <ListCard label={label || copy.title}>
        {previews.map((preview) => (
          <ListRow
            key={preview.id}
            label={preview.label || copy.port(preview.target)}
            sub={[copy.port(preview.target), ownerName?.(preview)]
              .filter(Boolean)
              .join(" · ")}
          >
            <a
              className="button secondary compact"
              href={previewHref(preview)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {copy.open}
            </a>
            {onStop && (
              <button
                type="button"
                className="button secondary compact"
                disabled={busy === preview.id}
                onClick={() => stop(preview)}
              >
                {copy.stop}
              </button>
            )}
          </ListRow>
        ))}
      </ListCard>
    </>
  );
}
