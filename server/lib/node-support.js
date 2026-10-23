// Node.js releases that carry the October 2026 security fixes.
// Keep in sync with package.json "engines" and scripts/install.sh.
export const MINIMUM_NODE_RELEASES = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };
export function isPatchedNode(version = process.versions.node) {
  const [major, minor = 0, patch = 0] = String(version).split(".").map(Number);
  if (major > 26) return true;
  const floor = MINIMUM_NODE_RELEASES[major];
  return (
    Boolean(floor) && (minor > floor[0] || (minor === floor[0] && patch >= floor[1]))
  );
}
