import { useEffect, useState } from "react";
import api from "../../lib/api.js";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { Pagination } from "../../components/Pagination.jsx";
import { commonCopy } from "../../lib/i18n/de/common.js";
import { memoryCopy as copy } from "../../lib/i18n/de/memory.js";
import { memoryPaging, entryAuthor } from "./memory-presentation.js";

export default function MemoryHistory({ projectId, entry, close }) {
  const [page, setPage] = useState(1),
    [resource, setResource] = useState(null),
    [refreshVersion, setRefreshVersion] = useState(0);
  const requestKey = JSON.stringify([projectId, entry.id, page, refreshVersion]);
  const current = resource?.key === requestKey;
  const data = current ? resource.data : null;
  const error = current ? resource.error : "";
  useEffect(() => {
    const controller = new AbortController();
    api(
      `/memory/projects/${encodeURIComponent(projectId)}/entries/${encodeURIComponent(entry.id)}/revisions?page=${page}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setResource({ key: requestKey, data: result, error: "" });
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setResource({ key: requestKey, data: null, error: error.message });
      });
    return () => controller.abort();
  }, [projectId, entry.id, page, requestKey]);
  return (
    <Modal title={copy.historyTitle} close={close} wide>
      <section className="memory-history">
        {!current && <p role="status">{commonCopy.pending}</p>}
        <ErrorMessage error={error} />
        {error && (
          <button
            className="button secondary"
            onClick={() => setRefreshVersion((value) => value + 1)}
          >
            {commonCopy.retry}
          </button>
        )}
        {data?.items.map((revision) => (
          <article key={revision.revision}>
            <h3>
              {copy.version(revision.revision)} · {revision.title}
            </h3>
            <small>
              {entryAuthor(revision)} · {revision.updatedAt}
            </small>
            <pre>{revision.content}</pre>
          </article>
        ))}
        {data && (
          <Pagination
            label={copy.historyTitle}
            paging={memoryPaging(data, page, setPage)}
          />
        )}
      </section>
    </Modal>
  );
}
