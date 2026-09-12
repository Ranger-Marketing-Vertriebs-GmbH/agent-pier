import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import useResource from "../../lib/useResource.js";
import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";

const externalUrl = (value) => {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
};
export default function ReleaseNotes({ version }) {
  const resource = useResource(
    `/operations/releases/notes/${encodeURIComponent(version)}`,
  );
  const notes = resource.data?.version === version ? resource.data : null;
  return (
    <section className="release-notes" aria-label={copy.releaseNotes}>
      <h3>{copy.releaseNotes}</h3>
      {resource.loading ? (
        <p role="status">{copy.releaseNotesLoading}</p>
      ) : notes?.body ? (
        <div className="release-notes-content">
          <Markdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            urlTransform={externalUrl}
            components={{
              a: ({ node: _node, href, ...props }) => (
                <a {...props} href={href} target="_blank" rel="noopener noreferrer" />
              ),
              img: ({ alt }) => <span>{alt}</span>,
            }}
          >
            {notes.body}
          </Markdown>
        </div>
      ) : (
        <p>{copy.releaseNotesUnavailable}</p>
      )}
      {notes?.url && externalUrl(notes.url) && (
        <a href={externalUrl(notes.url)} target="_blank" rel="noopener noreferrer">
          {copy.releaseNotesOriginal}
        </a>
      )}
    </section>
  );
}
