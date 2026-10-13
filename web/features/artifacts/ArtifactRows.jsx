import React from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import Icon from "../../components/Icon.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { locale } from "../../lib/i18n/index.js";
import { artifactCopy as copy } from "../../lib/i18n/messages/artifacts.js";
import {
  artifactKind,
  artifactSourceLine,
  exactTime,
  groupArtifactsByDate,
  relativeTime,
} from "./artifact-presentation.js";

const glyphs = {
  page: "M6 3h9l4 4v14H6Z M14 3v5h5 M9 13h7 M9 17h5",
  image: "M4 5h16v14H4Z M4 16l5-5 4 4 2-2 5 5 M15.5 9.5h.01",
  file: "M6 3h9l4 4v14H6Z M14 3v5h5",
};

/** A tinted tile: web pages on the accent tint, images on blue. */
export function ArtifactTypeIcon({ mediaType }) {
  const kind = artifactKind(mediaType);
  return (
    <span className={`artifact-type is-${kind}`}>
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={glyphs[kind]} />
      </svg>
    </span>
  );
}

export function ArtifactTime({ value, now }) {
  return (
    <time dateTime={value} title={exactTime(value, locale)}>
      {relativeTime(value, { now, locale, justNow: copy.justNow })}
    </time>
  );
}

export function ArtifactTitle({ item }) {
  return (
    <>
      {item.title}
      {item.pinned && (
        <span className="artifact-pin" role="img" aria-label={copy.pinned}>
          <Icon name="star" size={12} fill />
        </span>
      )}
    </>
  );
}

// A selected row is the selection in a list (aria-current="true"), not a page.
function ArtifactRow({ item, now, sub, selected, onSelect, href, target, children }) {
  return (
    <ListRow
      icon={<ArtifactTypeIcon mediaType={item.mediaType} />}
      label={<ArtifactTitle item={item} />}
      sub={sub}
      value={<ArtifactTime value={item.updatedAt} now={now} />}
      onClick={onSelect ? () => onSelect(item) : undefined}
      href={href}
      target={target}
      current={selected ? "true" : false}
      className={["artifact-row", selected ? "is-selected" : ""].join(" ").trim()}
    >
      {children}
    </ListRow>
  );
}

/**
 * Artifacts grouped by date (Today, Yesterday, This week, Earlier). Rows open the
 * detail through `onSelect`; `hrefFor` gives each row its in-app address.
 */
export default function ArtifactRows({ items, lists, selectedId, onSelect, hrefFor }) {
  const now = new Date();
  return groupArtifactsByDate(items, now).map(({ group, items: rows }) => (
    <section key={group} className="artifact-group">
      <GroupLabel id={`artifact-group-${group}`}>{copy.groups[group]}</GroupLabel>
      <ListCard labelledBy={`artifact-group-${group}`}>
        {rows.map((item) => (
          <ArtifactRow
            key={item.id}
            item={item}
            now={now}
            sub={artifactSourceLine(item, lists, copy) || undefined}
            selected={item.id === selectedId}
            onSelect={onSelect}
            href={hrefFor?.(item)}
          />
        ))}
      </ListCard>
    </section>
  ));
}

/**
 * The compact form for one session: no source line (the session is the source) and no
 * groups; each row opens the viewer in a new tab, as Open did, and `detailFor` adds a
 * secondary link to the artifact's detail.
 */
export function CompactArtifactRows({ items, label, linkFor, detailFor }) {
  const now = new Date();
  return (
    <ListCard label={label} className="artifact-rows-compact">
      {items.map((item) => (
        <ArtifactRow
          key={item.id}
          item={item}
          now={now}
          href={linkFor(item)}
          target="_blank"
        >
          {detailFor && (
            <a
              className="list-row-icon-button"
              aria-label={copy.showDetails(item.title)}
              {...detailFor(item)}
            >
              <Icon name="info" size={16} />
            </a>
          )}
        </ArtifactRow>
      ))}
    </ListCard>
  );
}
