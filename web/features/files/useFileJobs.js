import { useMemo, useSyncExternalStore } from "react";
import { FileJobClient } from "./file-job-client.js";

/** Writes require the opened scope: start(scopeId, operation), cancel(scopeId, id),
 * resolve(scopeId, id, decision). refresh({jobId, cursor}) appends one result page.
 * Entries are keyed by job ID; a new client synchronously receives a new snapshot.
 */
export default function useFileJobs(client) {
  const session = useMemo(() => new FileJobClient(client), [client]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    ...state,
    trackedIds: [...session.tracked.keys()],
    start: session.start,
    cancel: session.cancel,
    resolve: session.resolve,
    refresh: session.refresh,
    subscribe: session.subscribe,
    getSnapshot: session.getSnapshot,
    uploadRequest: session.uploads.request,
    inspect: session.uploads.inspect,
    loadUploadGroup: session.uploads.load,
    uploadHistory: session.uploads.history,
    selectUploadGroup: session.uploads.select,
    historyPage: session.uploads.history,
    inspectResults: session.operations.inspect,
    loadOmissions: session.operations.omissions,
    retryPreview: session.operations.retryPreview,
    retryJob: session.operations.retry,
  };
}
