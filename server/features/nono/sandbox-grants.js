/**
 * A grant is one capability a sandboxed session needs so that a single AgentPier
 * integration keeps working. Adapters declare their own grants; the nono adapter
 * only consumes them. Grants are per launch, never cached per account: chat
 * attachments live under a per-session directory.
 *
 * "read", "write" and "allow" are filesystem capabilities. "socket" and
 * "socket-dir-bind" are not: "socket" expresses connect() to one AF_UNIX
 * socket path, and "socket-dir-bind" expresses connect() and bind() for any
 * socket directly inside a directory. Both are grants nono expresses through
 * their own flags rather than through file access, so each is tracked
 * independently of a filesystem grant, or of each other, naming the same
 * path.
 */
const kind = (grant) =>
  grant.access === "socket" || grant.access === "socket-dir-bind" ? grant.access : "file";

/**
 * Returns a copy of the launch with one more grant appended. The adapter chain
 * hands the same launch object from one adapter to the next, so the input is
 * never mutated.
 */
export function addGrant(launch, grant) {
  return { ...launch, sandboxGrants: [...(launch.sandboxGrants || []), grant] };
}

/**
 * Collapses grants that name the same path to a single capability. Two different
 * filesystem accesses on one path together mean full access: read beside write is
 * "allow", and anything beside "allow" is already "allow". A socket grant never
 * merges with a filesystem grant, so a path used as both keeps both entries.
 *
 * Paths are compared as exact strings: a grant on a parent directory does not
 * absorb a grant on a file below it.
 */
export function mergeGrants(grants) {
  const merged = new Map();
  for (const grant of grants || []) {
    const key = `${kind(grant)}\0${grant.path}`;
    const previous = merged.get(key);
    merged.set(
      key,
      !previous || previous.access === grant.access
        ? grant
        : { access: "allow", path: grant.path },
    );
  }
  return [...merged.values()];
}
