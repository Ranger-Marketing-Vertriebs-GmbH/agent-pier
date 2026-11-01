import React from "react";
import { previewCopy as copy } from "../../lib/i18n/messages/previews.js";
import PreviewRows from "./PreviewRows.jsx";
import usePreviews from "./usePreviews.js";
import "./previews.css";

/**
 * The session's own previews, beside its artifacts: nothing while it has none, so a
 * session without a preview shows no section. Stop closes a preview (the list follows
 * the `previews` topic).
 */
export default function SessionPreviews({ sessionId }) {
  const { data, written } = usePreviews();
  const previews = (data?.previews || []).filter(
    (preview) => preview.owner?.sessionId === sessionId,
  );
  if (!previews.length) return null;
  return (
    <details className="session-previews">
      <summary>{copy.title}</summary>
      <section className="session-previews-panel" aria-label={copy.title}>
        <PreviewRows previews={previews} onStop={() => written()} />
      </section>
    </details>
  );
}
