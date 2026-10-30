import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { saveProjectGroups } from "./project-groups-api.js";
import {
  emptyGroupsDocument,
  findGroupByName,
  groupForPath,
  normalizeGroupsDocument,
  withAssignment,
  withGroupAt,
  withNewGroup,
  withRenamedGroup,
  withoutGroup,
} from "./project-groups.js";

// Menu actions report their own failures in `error`; callers need not catch.
const quietly = (promise) => promise.catch(() => null);

/**
 * The owner's project groups (`/api/project-groups`), followed over the live topic
 * `project-groups.changed`. Every change is an edit of the whole document: `update`
 * queues it, shows it at once (optimistic), and PUTs it on top of the newest saved
 * version. A conflict (409) adopts the server's document and drops the edit; any
 * other error rolls it back and reports it in `error`.
 */
export default function useProjectGroups() {
  const live = useLiveTopic("project-groups.changed", "/project-groups");
  const saved = useRef(emptyGroupsDocument);
  const [confirmed, setConfirmed] = useState(emptyGroupsDocument);
  const [pending, setPending] = useState([]);
  const [error, setError] = useState("");
  const queue = useRef(Promise.resolve());

  // A read never replaces a newer saved document (`trusted` skips the check for the
  // server's answer to a write, which may carry a lower version after a restore). A
  // newer document clears the last error, which it may have resolved.
  const adopt = useCallback((document, trusted = false) => {
    const next = normalizeGroupsDocument(document);
    if (!trusted && next.version < saved.current.version) return;
    if (next.version > saved.current.version) setError("");
    saved.current = next;
    setConfirmed(next);
  }, []);
  // Live reads are ignored when older than the saved document: a read that started
  // before our own write may arrive after its answer and would undo it. Write answers
  // are trusted because the server just wrote them.
  useEffect(() => {
    if (live.data) adopt(live.data);
  }, [live.data, adopt]);

  /**
   * Applies `change(document) => document` and saves it. Resolves with the saved
   * document, rejects with the error. `optimistic: false` shows the edit only once
   * saved; `report: false` leaves the error to the caller (an inline field).
   */
  const update = useCallback(
    (change, { optimistic = true, report = true } = {}) => {
      const entry = { change };
      if (optimistic) setPending((list) => [...list, entry]);
      const run = async () => {
        try {
          const base = saved.current;
          const next = change(base);
          if (!next || next === base) return base;
          adopt(await saveProjectGroups({ ...next, version: base.version }), true);
          setError("");
          return saved.current;
        } catch (failure) {
          if (failure.document) adopt(failure.document, true);
          if (report) setError(failure.message);
          throw failure;
        } finally {
          if (optimistic) setPending((list) => list.filter((item) => item !== entry));
        }
      };
      const result = queue.current.then(run);
      queue.current = result.catch(() => {});
      return result;
    },
    [adopt],
  );

  const document = useMemo(
    () => pending.reduce((current, { change }) => change(current) || current, confirmed),
    [pending, confirmed],
  );

  const moveProject = useCallback(
    (path, groupId) =>
      quietly(update((current) => withAssignment(current, path, groupId))),
    [update],
  );
  const removeProject = useCallback((path) => moveProject(path, null), [moveProject]);
  // A new group gets its id from the server, so a project moves in a second save.
  // Rejects (unreported) when the group cannot be created, for an inline message.
  const createGroup = useCallback(
    async (name, path = "") => {
      const created = await update((current) => withNewGroup(current, name), {
        optimistic: false,
        report: false,
      });
      const group = findGroupByName(created, name);
      if (path && group) await moveProject(path, group.id);
      return group;
    },
    [update, moveProject],
  );

  // Rejects (unreported) so the inline name field can show the message.
  const renameGroup = useCallback(
    (groupId, name) =>
      update((current) => withRenamedGroup(current, groupId, name), { report: false }),
    [update],
  );
  // Moves a group to an absolute position (drag, or Move up / down from the shown
  // index). Absolute, so re-applying the pending edit over a saved document that
  // already contains it changes nothing.
  const moveGroupTo = useCallback(
    (groupId, index) =>
      quietly(update((current) => withGroupAt(current, groupId, index))),
    [update],
  );
  const deleteGroup = useCallback(
    (groupId) => quietly(update((current) => withoutGroup(current, groupId))),
    [update],
  );

  return {
    document,
    loading: live.loading,
    error: error || live.error,
    groupOf: useCallback((path) => groupForPath(document, path), [document]),
    update,
    moveProject,
    removeProject,
    createGroup,
    renameGroup,
    moveGroupTo,
    deleteGroup,
  };
}
