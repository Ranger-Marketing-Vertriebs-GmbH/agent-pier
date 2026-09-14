import { useMemo, useRef, useSyncExternalStore } from "react";
import { FileUploadClient } from "./file-upload-client.js";

export default function useFileUploads({
  client,
  folder,
  scopeId,
  jobs,
  limits,
  readOnly,
}) {
  // Client/scope replacement creates the new snapshot during render. Folder changes
  // only change the destination of the next explicit selection.
  const owner = useMemo(
    () => new FileUploadClient(client, scopeId, jobs, limits, readOnly),
    [client, scopeId], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const current = useRef(owner);
  current.current = owner;
  owner.isCurrent = () => current.current === owner;
  owner.readOnly = readOnly;
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  return {
    ...state,
    items: state.selected?.rows || [],
    busy: state.groups.some(
      (group) =>
        group.submitting ||
        [...group.attempts.values()].some((attempt) =>
          ["reserving", "waiting", "sending"].includes(attempt.phase),
        ),
    ),
    add: (input) => owner.add(input, folder),
    select: owner.select,
    recover: owner.recover,
    reselect: owner.reselect,
    retry: owner.retry,
    cancel: owner.cancel,
  };
}
