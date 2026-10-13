import React, { useEffect, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { Pagination } from "../../components/Pagination.jsx";
import { isPlainClick } from "../../components/link-click.js";
import { artifactCopy as copy } from "../../lib/i18n/messages/artifacts.js";
import { routePath } from "../../app/routes.js";
import { CompactArtifactRows } from "./ArtifactRows.jsx";
import { artifactLink } from "./artifact-return-link.js";
import { artifactsRoute } from "./routes.js";
import useArtifacts from "./useArtifacts.js";
import "./artifacts.css";

const pageSize = 20;

/**
 * The session's own artifacts in compact rows; a row opens the viewer in a new tab
 * that returns to this session. Pinning and deleting live on the Artifacts page.
 */
export default function SessionArtifacts({ sessionId, returnTo, navigate }) {
  const [page, setPage] = useState(1);
  const { data, error } = useArtifacts({ sessionId, page });
  const pageCount = Math.max(1, Math.ceil((data?.total || 0) / pageSize));
  useEffect(() => {
    if (data && page > pageCount) setPage(pageCount);
  }, [data, page, pageCount]);
  // The Artifacts page, filtered to this session's project once one is known.
  const manage = artifactsRoute({ projectId: data?.items?.[0]?.projectId || "" });
  return (
    <section className="session-artifacts-panel" aria-label={copy.title}>
      <ErrorMessage error={error} />
      {!data ? (
        <p className="loading" role="status">
          {copy.listLoading}
        </p>
      ) : !data.items?.length ? (
        <p className="artifacts-empty">{copy.sessionPanelEmpty}</p>
      ) : (
        <>
          <CompactArtifactRows
            items={data.items}
            label={copy.title}
            linkFor={(item) =>
              artifactLink(`/artifacts/view/${encodeURIComponent(item.id)}`, returnTo)
            }
          />
          <Pagination
            label={copy.title}
            paging={{
              page: page - 1,
              pageSize,
              pageCount,
              total: data.total,
              start: (page - 1) * pageSize + 1,
              end: Math.min(page * pageSize, data.total),
              setPage: (value) => setPage(value + 1),
            }}
          />
        </>
      )}
      {navigate && (
        <a
          className="session-artifacts-manage"
          href={routePath(manage)}
          onClick={(event) => {
            if (!isPlainClick(event)) return;
            event.preventDefault();
            navigate(manage);
          }}
        >
          {copy.manage}
        </a>
      )}
    </section>
  );
}
