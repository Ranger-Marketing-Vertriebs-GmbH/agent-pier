import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import useResource from "../../lib/useResource.js";
import { locale } from "../../lib/i18n/index.js";
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
const publishedDate = (value) => {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime())
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date)
    : "";
};
const rangeStart = (version, from) =>
  typeof from === "string" &&
  /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(from) &&
  from !== version;
const notesPath = (version, from) =>
  rangeStart(version, from)
    ? `/operations/releases/notes?from=${encodeURIComponent(from)}&to=${encodeURIComponent(version)}`
    : `/operations/releases/notes/${encodeURIComponent(version)}`;

function OriginalLink({ url, children }) {
  const href = externalUrl(url);
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : null;
}
function NotesBody({ body }) {
  return (
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
        {body}
      </Markdown>
    </div>
  );
}

// Notes are optional: loading or failures never block staging or activation.
export default function ReleaseNotes({ version, from }) {
  const ranged = rangeStart(version, from);
  const resource = useResource(notesPath(version, from));
  const data = resource.data;
  const releases = ranged
    ? data?.to === version && Array.isArray(data.releases)
      ? data.releases
      : []
    : data?.version === version
      ? [data]
      : [];
  const title = ranged ? copy.releaseNotesSince(from) : copy.releaseNotes;
  const unavailable = !releases.some((release) => release.body);
  return (
    <section className="release-notes" aria-label={title}>
      <h3>{title}</h3>
      {resource.loading ? (
        <p role="status">{copy.releaseNotesLoading}</p>
      ) : unavailable ? (
        <>
          <p>{copy.releaseNotesUnavailable}</p>
          {releases.length === 1 && (
            <OriginalLink url={releases[0].url}>{copy.releaseNotesOriginal}</OriginalLink>
          )}
        </>
      ) : (
        releases.map((release, index) => {
          const date = publishedDate(release.publishedAt);
          return (
            <details
              className="release-notes-version"
              key={release.version}
              open={index === 0}
            >
              <summary>
                <span className="release-notes-number">{release.version}</span>
                {date && (
                  <span className="release-notes-date">
                    {" "}
                    · {copy.releaseNotesPublished(date)}
                  </span>
                )}
              </summary>
              {release.body ? (
                <NotesBody body={release.body} />
              ) : (
                <p>{copy.releaseNotesEmpty}</p>
              )}
              <OriginalLink url={release.url}>{copy.releaseNotesOriginal}</OriginalLink>
            </details>
          );
        })
      )}
      {!resource.loading && data?.truncated && (
        <p className="release-notes-overflow">
          {copy.releaseNotesOverflow(releases.length)}{" "}
          <OriginalLink url={data.url}>{copy.releaseNotesAll}</OriginalLink>
        </p>
      )}
    </section>
  );
}
