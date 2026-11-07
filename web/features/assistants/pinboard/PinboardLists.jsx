import React, { useEffect, useId, useRef, useState } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import Icon from "../../../components/Icon.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import StatusChip from "../../../components/StatusChip.jsx";
import { agentPinboardCopy as copy } from "../../../lib/i18n/messages/agent-pinboard.js";
import { entryDetail, listTime, pinboardSections } from "./pinboard-view.js";
import "./pinboard.css";

const kindIcons = {
  text: "file",
  video: "video",
  image: "image",
  audio: "audio",
  file: "paperclip",
};

function EntryRows({ list, label, labelledBy, onOpenEntry }) {
  return (
    <ListCard label={label} labelledBy={labelledBy}>
      {list.entries.map((entry) => {
        const gone = entry.state === "unavailable";
        const kind = kindIcons[entry.kind] ? entry.kind : "file";
        return (
          <ListRow
            key={entry.id}
            className="pinboard-entry"
            icon={<Icon name={kindIcons[kind]} />}
            label={entry.name}
            sub={entryDetail(entry, copy) || copy.kinds[kind]}
            value={
              entry.fresh ? (
                <StatusChip tone="waiting" pill>
                  {copy.fresh}
                </StatusChip>
              ) : null
            }
            chevron={!gone}
            disabled={gone}
            onClick={() => onOpenEntry(list.id, entry.id)}
          />
        );
      })}
    </ListCard>
  );
}

// The current time, a minute at a time: the lists' "4 minutes ago" moves on.
function useMinute() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function OpenList({ list, now, onOpenEntry, onOpenChat, anchor }) {
  const titleId = useId();
  const origin = list.origin;
  return (
    <section className="pinboard-list" ref={anchor} data-list-id={list.id}>
      <h3 id={titleId} className="pinboard-list-title">
        {list.title}
      </h3>
      <p className="pinboard-list-meta">
        <time dateTime={list.updatedAt}>{listTime(list.updatedAt, now)}</time>
        {origin && (
          <>
            {" · "}
            <button
              type="button"
              className="pinboard-origin"
              onClick={() => onOpenChat(origin.conversationId)}
            >
              {copy.from(origin.title || copy.chat)}
            </button>
          </>
        )}
      </p>
      {list.description && (
        <p className="pinboard-list-description">{list.description}</p>
      )}
      <EntryRows list={list} labelledBy={titleId} onOpenEntry={onOpenEntry} />
    </section>
  );
}

function ArchivedList({ list, expanded, onToggle, onOpenEntry, anchor }) {
  const bodyId = useId();
  return (
    <div className="pinboard-archived-list" ref={anchor} data-list-id={list.id}>
      <button
        type="button"
        className="pinboard-archived-toggle"
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        onClick={onToggle}
      >
        <span>{copy.archived(list.title)}</span>
        <Icon name={expanded ? "down" : "chevron"} size={14} />
      </button>
      {expanded && (
        <div id={bodyId}>
          {list.description && (
            <p className="pinboard-list-description">{list.description}</p>
          )}
          <EntryRows list={list} label={list.title} onOpenEntry={onOpenEntry} />
        </div>
      )}
    </div>
  );
}

/**
 * An agent's pinboard lists (the view route's answer): open lists newest first, each
 * with its title, time, the chat it came from, its description and its files (NEW
 * once changed, "No longer available" when the share rules refuse the file); archived
 * lists collapsed at the bottom. `focusListId` is scrolled into view (and expanded
 * when archived) once it shows.
 */
export default function PinboardLists({ view, focusListId, onOpenEntry, onOpenChat }) {
  const { open, archived } = pinboardSections(view);
  const now = useMinute();
  const [expanded, setExpanded] = useState(() => new Set());
  const anchors = useRef(new Map());
  const scrolled = useRef(null);
  const anchor = (id) => (element) => {
    if (element) anchors.current.set(id, element);
    else anchors.current.delete(id);
  };
  const focusArchived = archived.some((list) => list.id === focusListId);

  useEffect(() => {
    if (!focusListId) {
      scrolled.current = null;
      return;
    }
    if (focusArchived)
      setExpanded((current) =>
        current.has(focusListId) ? current : new Set(current).add(focusListId),
      );
    const element = anchors.current.get(focusListId);
    if (!element || scrolled.current === focusListId) return;
    scrolled.current = focusListId;
    element.scrollIntoView({ block: "start" });
  }, [focusListId, focusArchived, view]);

  if (!open.length && !archived.length)
    return <p className="pinboard-empty">{copy.empty}</p>;
  const toggle = (id) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <div className="pinboard-lists">
      {open.map((list) => (
        <OpenList
          key={list.id}
          list={list}
          now={now}
          anchor={anchor(list.id)}
          onOpenEntry={onOpenEntry}
          onOpenChat={onOpenChat}
        />
      ))}
      {archived.length > 0 && (
        <section className="pinboard-archived">
          <GroupLabel as="h3">{copy.archivedGroup}</GroupLabel>
          {archived.map((list) => (
            <ArchivedList
              key={list.id}
              list={list}
              anchor={anchor(list.id)}
              expanded={expanded.has(list.id)}
              onToggle={() => toggle(list.id)}
              onOpenEntry={onOpenEntry}
            />
          ))}
        </section>
      )}
    </div>
  );
}
