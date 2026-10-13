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
 * The session's own artifacts in compact rows: a row opens the viewer in a new tab that
 * returns to this session, its ⓘ action opens the artifact's detail on the Artifacts
 * page (pin, delete). "Manage in Artifacts" opens the page filtered to this session.
 */
export default function SessionArtifacts({ sessionId, returnTo, navigate }) {
  const [page, setPage] = useState(1);
  const { data, error } = useArtifacts({ sessionId, page });
  const pageCount = Math.max(1, Math.ceil((data?.total || 0) / pageSize));
  useEffect(() => {
    if (data && page > pageCount) setPage(pageCount);
  }, [data, page, pageCount]);
  const manage = artifactsRoute({ session: sessionId });
  const open = (event, route) => {
    if (!isPlainClick(event) || !navigate) return;
    event.preventDefault();
    navigate(route);
  };
  const detail = (item) => artifactsRoute({ session: sessionId, artifact: item.id });
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
          <p className="session-artifacts-hint">{copy.retention}</p>
          <CompactArtifactRows
            items={data.items}
            label={copy.title}
            linkFor={(item) =>
              artifactLink(`/artifacts/view/${encodeURIComponent(item.id)}`, returnTo)
            }
            detailFor={(item) => ({
              href: routePath(detail(item)),
              onClick: (event) => open(event, detail(item)),
            })}
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
          onClick={(event) => open(event, manage)}
        >
          {copy.manage}
        </a>
      )}
    </section>
  );
}
