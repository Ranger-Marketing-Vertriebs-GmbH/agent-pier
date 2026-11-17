import React, { useEffect, useRef, useState } from "react";
import ChatMarkdown from "../../../../components/ChatMarkdown.jsx";
import ErrorMessage from "../../../../components/ErrorMessage.jsx";
import ListCard from "../../../../components/ListCard.jsx";
import ListRow from "../../../../components/ListRow.jsx";
import { locale } from "../../../../lib/i18n/index.js";
import { assistantMemoryWikiCopy as copy } from "../../../../lib/i18n/messages/assistant-memory-wiki.js";
import useLiveTopic from "../../../../lib/live/useLiveTopic.js";
import SubpageHeader from "../../settings/SubpageHeader.jsx";
import { memoryWikiApi } from "./api.js";

const when = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
};
const pageSub = (page) =>
  [
    copy.page.kinds[page.kind] || page.kind,
    page.updatedAt && copy.page.updated(when(page.updatedAt)),
  ]
    .filter(Boolean)
    .join(" · ");

/**
 * An agent's memory wiki, read only (docs/agents.md): OpenClaw's built surface in the
 * slot `agent.page`, below the agent's Capabilities tab. The list of pages (title,
 * kind, updated) is the live topic `agent.wiki:<id>`, pushed when a turn of the agent
 * ends a wiki tool call; a page opens in place, rendered with ChatMarkdown (no raw
 * HTML, no remote images), and is read again when the list changes.
 */
export default function WikiPage({ context }) {
  const { assistant, onBack } = context;
  const topic = useLiveTopic(`agent.wiki:${assistant.id}`);
  const [open, setOpen] = useState(null);
  const [page, setPage] = useState(null);
  const [error, setError] = useState("");
  const listing = topic.data;
  // A pushed listing reads the open page again.
  const seen = useRef(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!listing) return;
    const value = JSON.stringify(listing);
    if (seen.current !== null && seen.current !== value) setVersion((n) => n + 1);
    seen.current = value;
  }, [listing]);
  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setError("");
    memoryWikiApi.page(assistant.id, open).then(
      (next) => active && setPage(next),
      () => active && setError(copy.page.unavailable),
    );
    return () => {
      active = false;
    };
  }, [assistant.id, open, version]);
  const close = () => {
    setOpen(null);
    setPage(null);
    setError("");
  };
  return (
    <section className="agent-subpage" aria-label={copy.title} data-surface="wiki">
      <SubpageHeader
        title={copy.title}
        tab="capabilities"
        onBack={open ? close : onBack}
        hint={copy.hint}
      />
      <ErrorMessage
        error={error || (topic.error && !listing ? copy.page.unavailable : "")}
      />
      {open ? (
        <>
          <ListCard label={copy.page.back}>
            <ListRow label={copy.page.back} chevron={false} onClick={close} />
          </ListCard>
          {page && page.lookup === open && (
            <article className="list-card agent-wiki-page" aria-label={page.title}>
              <p className="field-description">{pageSub(page)}</p>
              {page.truncated && <p className="field-description">{copy.page.cut}</p>}
              <div className="message-content agent-markdown-preview">
                <ChatMarkdown>{page.content}</ChatMarkdown>
              </div>
            </article>
          )}
        </>
      ) : !listing ? (
        topic.loading && (
          <p className="loading" role="status">
            {copy.page.loading}
          </p>
        )
      ) : (
        <ListCard label={copy.page.pages}>
          {listing.state === "building" && <ListRow label={copy.page.building} />}
          {listing.state !== "building" && !listing.pages.length && (
            <ListRow label={copy.page.empty} />
          )}
          {listing.pages.map((entry) => (
            <ListRow
              key={entry.lookup}
              label={entry.title || entry.lookup}
              sub={pageSub(entry)}
              onClick={() => setOpen(entry.lookup)}
            />
          ))}
          {listing.pages.length > 0 && (
            <ListRow
              label={copy.page.count(listing.pages.length, listing.totalPages)}
              sub={listing.truncated ? copy.page.truncated : undefined}
            />
          )}
        </ListCard>
      )}
    </section>
  );
}
