import { useEffect, useRef, useState } from "react";

/**
 * The selected file's metadata and preview for the properties pane. `owner` is the
 * explorer's selection owner: results of an earlier selection are never shown. A new
 * `revision` of the same file (a change on disk seen by the listing) reads both again
 * and keeps the shown ones until the new ones arrive, so the preview never goes stale.
 */
export default function useFileDetails({
  client,
  scopeId,
  file,
  revision,
  owner,
  linkOperation,
}) {
  const [entryResult, setEntry] = useState(null);
  const [propertiesError, setPropertiesError] = useState(null);
  const [propertiesLoading, setPropertiesLoading] = useState(false);
  const [previewResult, setPreviewResult] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const loaded = useRef(null);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const entry = entryResult?.owner === owner ? entryResult.value : null;
  const preview = previewResult?.owner === owner ? previewResult.value : null;
  // Counts the revisions of this file seen after the first: the listing's first
  // answer is no change on disk and reads nothing again.
  const version = useRef({ file, revision, changes: 0 });
  if (version.current.file !== file) version.current = { file, revision, changes: 0 };
  else if (revision !== undefined && revision !== version.current.revision)
    version.current = {
      file,
      revision,
      changes: version.current.changes + (version.current.revision === undefined ? 0 : 1),
    };
  const changes = version.current.changes;

  useEffect(() => {
    const owner = ownerRef.current;
    const controller = new AbortController();
    const cancelLink = () => {
      linkOperation.current.controller?.abort();
      linkOperation.current = {
        generation: linkOperation.current.generation + 1,
        controller: null,
      };
    };
    const stop = () => {
      controller.abort();
      cancelLink();
    };
    cancelLink();
    const reread = loaded.current === owner;
    loaded.current = owner;
    if (!reread) {
      setEntry(null);
      setPreviewResult(null);
      setPropertiesLoading(false);
    }
    setPropertiesError(null);
    setPreviewError(null);
    if (!scopeId || !file) return stop;
    if (!reread) setPropertiesLoading(true);
    client
      .get("/metadata", { path: file }, controller.signal)
      .then(async (result) => {
        if (controller.signal.aborted) return;
        setEntry({ owner, value: result });
        if (result.type === "file") {
          try {
            const value = await client.get("/preview", { path: file }, controller.signal);
            if (!controller.signal.aborted) setPreviewResult({ owner, value });
          } catch (issue) {
            if (!controller.signal.aborted) setPreviewError(issue);
          }
        }
      })
      .catch((issue) => {
        if (!controller.signal.aborted) setPropertiesError(issue);
      })
      .finally(() => {
        if (!controller.signal.aborted) setPropertiesLoading(false);
      });
    return stop;
    // `changes` only triggers a fresh read of the same selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, scopeId, file, changes]);

  return {
    entry,
    preview,
    previewError,
    propertiesError,
    propertiesLoading,
    setPreviewResult,
    setPreviewError,
  };
}
