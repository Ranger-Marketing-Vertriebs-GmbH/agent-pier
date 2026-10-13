import React, { useId, useState } from "react";
import Icon from "../../components/Icon.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { locale } from "../../lib/i18n/index.js";
import { artifactCopy as copy } from "../../lib/i18n/messages/artifacts.js";
import {
  artifactTypeLabel,
  exactTime,
  formatBytes,
  shortId,
} from "./artifact-presentation.js";

/** Technical facts behind a disclosure, collapsed by default. */
export default function ArtifactFacts({ item, copyText }) {
  const [open, setOpen] = useState(false),
    [copied, setCopied] = useState(null);
  const id = useId();
  const size = formatBytes(item.sizeBytes, locale);
  return (
    <ListCard label={copy.details} className="artifact-facts">
      <div className="list-row">
        <button
          type="button"
          className="list-row-main artifact-disclosure"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="list-row-text">
            <span className="list-row-label">{copy.details}</span>
          </span>
          {!open && <span className="list-row-value">{copy.detailsSummary}</span>}
          <Icon name={open ? "up" : "down"} size={14} className="list-row-chevron" />
        </button>
      </div>
      <div id={id} className="artifact-facts-rows" hidden={!open}>
        <ListRow
          label={copy.type}
          value={copy.typeWithMedia(
            artifactTypeLabel(item.mediaType, copy.types),
            item.mediaType,
          )}
        />
        <ListRow
          label={copy.size}
          value={
            Number.isInteger(item.fileCount) ? copy.sizeFiles(size, item.fileCount) : size
          }
        />
        {item.createdAt && (
          <ListRow label={copy.published} value={exactTime(item.createdAt, locale)} />
        )}
        <ListRow label={copy.updated} value={exactTime(item.updatedAt, locale)} />
        <ListRow label={copy.id} value={<code title={item.id}>{shortId(item.id)}</code>}>
          <button
            type="button"
            className="list-row-icon-button"
            aria-label={copy.copyId}
            onClick={async () => setCopied(await copyText(item.id))}
          >
            <Icon name="copy" size={16} />
          </button>
        </ListRow>
        {copied !== null && (
          <p className="artifact-facts-note" role="status">
            {copied ? copy.idCopied : copy.idCopyFailed}
          </p>
        )}
      </div>
    </ListCard>
  );
}
