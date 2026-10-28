// What useWorkspaceState shows: the value the live `state` topic pushed, or the
// answer of the last refresh() (a REST read after a write). Every state carries
// `readStartedAt` (server/features/sessions/workspace-state.js), so the read that
// started later wins: a push from a read that began before the caller's write never
// replaces the refresh answer that already shows that write. Without stamps (older
// servers, test mocks) a push that arrived after the refresh began wins.
const stampOf = (data) =>
  Number.isFinite(data?.readStartedAt) ? data.readStartedAt : null;

/**
 * `live`: `{ data, error, loading }` of the topic. `read`: the last refresh as
 * `{ basis, data, error }`, where `basis` is the pushed value it started from, or
 * null. Returns `{ data, failure, loading }`; `failure` is the message to show.
 * A refresh error shows until the next refresh or the next pushed value.
 */
export function workspaceStateView(live, read) {
  const pushedSince = !read || read.basis !== live.data;
  let data = live.data ?? null;
  if (read?.data) {
    const [answered, pushed] = [stampOf(read.data), stampOf(live.data)];
    const newer =
      !data || (answered !== null && pushed !== null ? answered > pushed : !pushedSince);
    if (newer) data = read.data;
  }
  const failure = (read && !pushedSince ? read.error : live.error) || "";
  return { data, failure, loading: !data && !failure && Boolean(live.loading) };
}
