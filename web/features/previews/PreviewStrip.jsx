import React from "react";
import { previewCopy as copy } from "../../lib/i18n/messages/previews.js";
import PreviewRows from "./PreviewRows.jsx";
import usePreviews from "./usePreviews.js";
import "./previews.css";

/**
 * The previews an agent opened for this chat (agentpier_preview), as a compact strip
 * under the chat's header: nothing while the chat has none. Stop closes one; the list
 * follows the `previews` topic.
 */
export default function PreviewStrip({ conversationId }) {
  const { data, written } = usePreviews();
  const previews = (data?.previews || []).filter(
    (preview) => preview.owner?.conversationId === conversationId,
  );
  if (!conversationId || !previews.length) return null;
  return (
    <section className="agent-preview-strip" aria-label={copy.title}>
      <PreviewRows previews={previews} onStop={() => written()} />
    </section>
  );
}
