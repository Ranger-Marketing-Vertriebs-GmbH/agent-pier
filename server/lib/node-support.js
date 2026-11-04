// Node.js releases that carry the October 2026 security fixes.
// Keep in sync with package.json "engines" and scripts/install.sh.
export const MINIMUM_NODE_RELEASES = { 24: [22, 1], 26: [12, 1] };
export function isPatchedNode(version = process.versions.node) {
  const [major, minor = 0, patch = 0] = String(version).split(".").map(Number);
  if (major > 26) return true;
  const floor = MINIMUM_NODE_RELEASES[major];
  return (
    Boolean(floor) && (minor > floor[0] || (minor === floor[0] && patch >= floor[1]))
  );
}
// Doctor verdict: "fail" below Node 24 (Node 22 is no longer supported), "warn" for
// unpatched or unsupported odd majors, else "ok".
export function nodeCheckStatus(version = process.versions.node) {
  const [major] = String(version).split(".").map(Number);
  if (!(major >= 24)) return "fail";
  return isPatchedNode(version) ? "ok" : "warn";
}
