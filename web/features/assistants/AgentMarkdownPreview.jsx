import React from "react";
import ChatMarkdown from "../../components/ChatMarkdown.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import FileLink from "../../components/FileLink.jsx";
import SidePanel from "../../components/SidePanel.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { assistantAttachmentsCopy as copy } from "../../lib/i18n/messages/assistant-attachments.js";
import useMarkdownFile from "./useMarkdownFile.js";

/**
 * A Markdown file from the agent chat, rendered in a side panel (a bottom sheet on
 * phones) through ChatMarkdown: no raw HTML, remote images never load, links open in
 * a new tab. The text comes from the same signed-in route as the download, without
 * `download=1`, read up to the preview cap; a larger file, or one that fails to load,
 * says so and keeps the download. Escape, the close buttons and a click beside the
 * panel close it, and focus returns to the opener.
 */
export default function AgentMarkdownPreview({
  file,
  src,
  details,
  limit,
  opener,
  close,
}) {
  const state = useMarkdownFile(src, file);
  return (
    <SidePanel
      title={file.name}
      subtitle={details}
      close={close}
      opener={opener}
      cancelLabel={commonCopy.close}
      footer={
        <FileLink
          className="button primary"
          href={`${src}?download=1`}
          name={file.name}
          aria-label={copy.download(file.name)}
        >
          {copy.previewDownload}
        </FileLink>
      }
    >
      {state.loading ? (
        <p className="loading" role="status">
          {copy.previewLoading}
        </p>
      ) : state.failed ? (
        <ErrorMessage error={copy.previewFailed} />
      ) : state.tooLarge ? (
        <p className="agent-markdown-notice" role="status">
          {copy.previewTooLarge(limit)}
        </p>
      ) : (
        <div className="message-content agent-markdown-preview">
          <ChatMarkdown>{state.text}</ChatMarkdown>
        </div>
      )}
    </SidePanel>
  );
}
