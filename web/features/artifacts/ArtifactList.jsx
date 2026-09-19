import React, { useEffect, useState } from "react";
import api from "../../lib/api.js";
import { locale } from "../../lib/i18n/index.js";
import { artifactCopy as copy } from "../../lib/i18n/messages/artifacts.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { Pagination } from "../../components/Pagination.jsx";
import useArtifacts from "./useArtifacts.js";
import "./artifacts.css";
export default function ArtifactList({ sessionId, projectId }) {
  const [page, setPage] = useState(1),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [deleting, setDeleting] = useState(null);
  const {
    data,
    usage,
    error: readError,
    refresh,
  } = useArtifacts({ sessionId, projectId, page });
  const pageCount = Math.max(1, Math.ceil((data?.total || 0) / 20));
  useEffect(() => {
    if (data && page > pageCount) setPage(pageCount);
  }, [data, page, pageCount]);
  async function change(row, remove) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api(
        `/artifacts/${row.id}`,
        remove ? "DELETE" : "PATCH",
        remove ? undefined : { pinned: !row.pinned },
      );
      setDeleting(null);
      refresh();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  const bytes = (value) =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "megabyte",
      maximumFractionDigits: 2,
    }).format((value || 0) / 1048576);
  return (
    <section className="artifact-list" aria-label={copy.title}>
      <div className="artifact-list-toolbar">
        <p>{copy.retention}</p>
        <button className="button secondary compact" onClick={refresh}>
          {copy.refresh}
        </button>
      </div>
      {usage && (
        <p className="artifact-storage">
          {copy.storage(bytes(usage.usedBytes), bytes(usage.limitBytes))}
          {usage.pendingCleanupBytes > 0 && (
            <> · {copy.cleanup(bytes(usage.pendingCleanupBytes))}</>
          )}
        </p>
      )}
      <ErrorMessage>{error || readError}</ErrorMessage>
      {!data ? (
        <p role="status">{copy.listLoading}</p>
      ) : !data.items?.length ? (
        <p>{copy.empty}</p>
      ) : (
        <ul className="artifact-rows">
          {data.items.map((row) => (
            <li key={row.id}>
              <div className="artifact-description">
                <strong>{row.title}</strong>
                <span>
                  {row.mediaType} · {bytes(row.sizeBytes)} ·{" "}
                  {new Date(row.updatedAt).toLocaleString(locale)}
                </span>
                {row.pinned && <span className="artifact-badge">{copy.pinned}</span>}
                {row.orphaned && <span>{copy.orphaned}</span>}
              </div>
              <div className="artifact-actions">
                <a
                  className="button secondary compact"
                  href={`/artifacts/view/${row.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={copy.openLabel(row.title)}
                >
                  {copy.open}
                </a>
                <button
                  className="button secondary compact"
                  disabled={busy}
                  onClick={() =>
                    row.pinned && row.orphaned ? setDeleting(row) : change(row, false)
                  }
                >
                  {row.pinned ? copy.unpin : copy.pin}
                </button>
                <button
                  className="button secondary compact"
                  disabled={busy}
                  onClick={() => setDeleting(row)}
                >
                  {copy.remove}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Pagination
        label={copy.title}
        paging={{
          page: page - 1,
          pageSize: 20,
          pageCount,
          total: data?.total || 0,
          start: (page - 1) * 20 + 1,
          end: Math.min(page * 20, data?.total || 0),
          setPage: (value) => setPage(value + 1),
        }}
      />
      {deleting && (
        <Modal
          title={copy.deleteTitle}
          close={() => {
            if (!busy) setDeleting(null);
          }}
          closeDisabled={busy}
        >
          <p>
            {deleting.orphaned
              ? copy.deleteOrphan(deleting.title)
              : copy.deleteBody(deleting.title)}
          </p>
          <ErrorMessage>{error}</ErrorMessage>
          <div className="artifact-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              {commonCopy.cancel}
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => change(deleting, true)}
            >
              {copy.remove}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
