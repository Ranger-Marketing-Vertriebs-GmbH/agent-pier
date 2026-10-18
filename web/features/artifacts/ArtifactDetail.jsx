import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import Icon from "../../components/Icon.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { ToggleRow } from "../../components/ListRow.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
import Sheet from "../../components/Sheet.jsx";
import api from "../../lib/api.js";
import { artifactCopy as copy } from "../../lib/i18n/messages/artifacts.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { routePath } from "../../app/routes.js";
import { projectsRoute } from "../projects/routes.js";
import ArtifactFacts from "./ArtifactFacts.jsx";
import ArtifactPreview from "./ArtifactPreview.jsx";
import { ArtifactTime } from "./ArtifactRows.jsx";
import { artifactSource, artifactTypeLabel } from "./artifact-presentation.js";
import { artifactLink } from "./artifact-return-link.js";
import { downloadArtifact } from "./artifact-download.js";
import { writeClipboard } from "../../lib/clipboard.js";

function SourceGroup({ item, lists, navigate }) {
  const { session, sessionGone, project } = artifactSource(item, lists);
  const tool = session && (lists.tools || []).find((entry) => entry.id === session.tool);
  const sessionRoute = session && {
    view: "workspace",
    sessionId: session.id,
    mode: null,
  };
  const projectRoute = project && projectsRoute({ projectId: project.id });
  return (
    <section>
      <GroupLabel id="artifact-source">{copy.sourceGroup}</GroupLabel>
      <ListCard labelledBy="artifact-source">
        {sessionGone || !session ? (
          <ListRow
            icon={
              <span className="artifact-type">
                <Icon name="terminal" size={16} />
              </span>
            }
            label={sessionGone ? copy.sessionDeleted : copy.sessionLabel}
            sub={sessionGone ? copy.sessionGoneSub : undefined}
          />
        ) : (
          <ListRow
            icon={<ProviderMark tool={session.tool} size="row" />}
            label={session.name || copy.sessionUnnamed}
            sub={tool?.name ? copy.sessionSub(tool.name) : copy.sessionLabel}
            value={session.status === "stopped" ? copy.ended : copy.running}
            href={routePath(sessionRoute)}
            onClick={() => navigate(sessionRoute)}
          />
        )}
        {project && (
          <ListRow
            icon={
              <span className="artifact-type">
                <Icon name="folder" size={16} />
              </span>
            }
            label={project.name}
            sub={copy.projectSub}
            href={routePath(projectRoute)}
            onClick={() => navigate(projectRoute)}
          />
        )}
      </ListCard>
    </section>
  );
}

function ConfirmSheet({ confirm, item, busy, error, onConfirm, onCancel }) {
  const unpin = confirm === "unpin";
  return (
    <Sheet
      open={Boolean(confirm)}
      title={unpin ? copy.unpinTitle : copy.deleteTitle}
      onCancel={onCancel}
    >
      <p className="sheet-body">
        {unpin || item.orphaned
          ? copy.deleteOrphan(item.title)
          : copy.deleteBody(item.title)}
      </p>
      <ErrorMessage error={error} />
      <div className="sheet-actions">
        <button
          type="button"
          className="button danger"
          disabled={busy}
          onClick={onConfirm}
        >
          {unpin ? copy.unpinAndDelete : copy.remove}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={onCancel}
        >
          {commonCopy.cancel}
        </button>
      </div>
    </Sheet>
  );
}

/**
 * The selected artifact: preview, Open, Download and Copy link, where it came from, the pin and
 * its technical facts; Delete asks in a Sheet. `returnTo` is this detail's address.
 */
export default function ArtifactDetail({
  item,
  lists,
  returnTo,
  navigate,
  onChanged,
  onRemoved,
  heading = true,
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState(null),
    [copied, setCopied] = useState(null),
    [downloading, setDownloading] = useState(false),
    [downloadError, setDownloadError] = useState("");
  const viewer = `/artifacts/view/${encodeURIComponent(item.id)}`;
  async function change(remove) {
    setBusy(true);
    setError("");
    try {
      const result = await api(
        `/artifacts/${encodeURIComponent(item.id)}`,
        remove ? "DELETE" : "PATCH",
        remove ? undefined : { pinned: !item.pinned },
      );
      setConfirm(null);
      // Unpinning an artifact whose session is gone deletes it (the PATCH returns null).
      if (remove || !result) onRemoved();
      else onChanged();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  async function copyLink() {
    const url = new URL(viewer, window.location.origin).href;
    setCopied((await writeClipboard(url)) ? { ok: true } : { ok: false, url });
  }
  async function download() {
    setDownloading(true);
    setDownloadError("");
    try {
      await downloadArtifact(item);
    } catch (failure) {
      setDownloadError(failure.message);
    } finally {
      setDownloading(false);
    }
  }
  const cancel = () => {
    if (busy) return;
    setConfirm(null);
    setError("");
  };
  return (
    <article className="artifact-detail" aria-label={item.title}>
      <header className="artifact-detail-head">
        {heading && <h2>{item.title}</h2>}
        <p>
          {artifactTypeLabel(item.mediaType, copy.types)} ·{" "}
          <ArtifactTime value={item.updatedAt} now={new Date()} />
        </p>
      </header>
      <ArtifactPreview item={item} />
      <div className="artifact-detail-actions">
        <a
          className="button primary"
          href={artifactLink(viewer, returnTo)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={copy.openLabel(item.title)}
        >
          <Icon name="external" size={16} />
          {copy.open}
        </a>
        <button
          type="button"
          className="button secondary"
          disabled={downloading}
          aria-label={copy.downloadLabel(item.title)}
          onClick={download}
        >
          <Icon name="download" size={16} />
          {downloading ? copy.downloading : copy.download}
        </button>
        <button type="button" className="button secondary" onClick={copyLink}>
          <Icon name="link" size={16} />
          {copy.copyLink}
        </button>
      </div>
      <ErrorMessage error={downloadError} />
      <p className="artifact-detail-note" role="status">
        {copied ? (copied.ok ? copy.linkCopied : copy.copyFailed) : ""} {copy.linkHint}
      </p>
      {copied && !copied.ok && (
        <input
          className="artifact-link-field"
          readOnly
          value={copied.url}
          aria-label={copy.copyLink}
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
      <SourceGroup item={item} lists={lists} navigate={navigate} />
      <section>
        <GroupLabel id="artifact-keep">{copy.keepGroup}</GroupLabel>
        <ListCard labelledBy="artifact-keep">
          <ToggleRow
            label={copy.pinned}
            sub={copy.pinnedSub}
            checked={Boolean(item.pinned)}
            disabled={busy}
            onChange={(checked) =>
              !checked && item.orphaned ? setConfirm("unpin") : change(false)
            }
          />
        </ListCard>
        {!confirm && <ErrorMessage error={error} />}
      </section>
      <ArtifactFacts item={item} copyText={writeClipboard} />
      <ListCard label={copy.deleteRow} className="artifact-danger-card">
        <ListRow
          icon={<Icon name="trash" size={16} />}
          label={copy.deleteRow}
          sub={copy.deleteRowSub}
          onClick={() => setConfirm("delete")}
          chevron={false}
          disabled={busy}
          className="artifact-danger-row"
        />
      </ListCard>
      <ConfirmSheet
        confirm={confirm}
        item={item}
        busy={busy}
        error={error}
        onConfirm={() => change(confirm === "delete")}
        onCancel={cancel}
      />
    </article>
  );
}
