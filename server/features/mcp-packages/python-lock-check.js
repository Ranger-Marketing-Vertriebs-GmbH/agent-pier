import { lockDigest } from "./lock-check.js";
import { packageProblem } from "./package-errors.js";
import {
  canonicalPypiVersion,
  normalizePypiName,
  pypiVersionPattern,
} from "./package-spec.js";

const foreign = () => packageProblem("MCP_PACKAGE_FOREIGN_SOURCE", 400);
const mismatch = () => packageProblem("MCP_PACKAGE_INTEGRITY_MISMATCH", 502);
// `name==version`, an optional environment marker (D3), then the continuation to its
// hashes. No extras (`name[x]`), URL, path, option or comment fits this pattern.
const requirement =
  /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)==([^ \t;\\]+?)(?:[ \t]*;[ \t]*([^;]+?))?[ \t]*\\$/;
// Marker grammar characters only: no `/`, `:`, `@`, `#` or `\` can smuggle a source in,
// and no token starts with `-`, so no pip option (`-i`, `--no-binary`) hides in it.
const marker = /^[A-Za-z0-9_ .'"<>=!~()-]+$/;
const option = /(?:^|[ \t])-/;
const hash = /^--hash=sha256:([0-9a-f]{64})([ \t]*\\)?$/;
// Only ASCII space, tab and a CR from CRLF are whitespace; NBSP, U+2028 or a BOM fail.
const strip = (line) => line.replace(/^[ \t]+|[ \t\r]+$/g, "");

/**
 * Validates a `uv pip compile --generate-hashes --no-header --no-annotate` lock: only
 * exact pins from the configured index, each with at least one sha256 hash, and the
 * root package at the referenced version. Comments are refused, not skipped: AgentPier
 * never asks uv for any, and a comment could carry a stage path into the stored lock.
 * `digests` (the release's sha256 values on PyPI) must cover every root hash.
 */
export function checkPythonLock(text, { ref, digests = null }) {
  if (typeof text !== "string") throw packageProblem("MCP_PACKAGE_INSTALL_FAILED", 502);
  const hashes = new Map();
  const versions = new Map();
  let current = null;
  let continued = false;
  for (const raw of text.split("\n")) {
    const line = strip(raw);
    if (continued) {
      const match = hash.exec(line);
      if (!match) throw foreign();
      hashes.get(current).push(match[1]);
      continued = Boolean(match[2]);
      continue;
    }
    if (!line) continue;
    const req = requirement.exec(line);
    if (!req) throw foreign();
    const [, rawName, version, condition] = req;
    if (version.length > 128 || !pypiVersionPattern.test(version)) throw foreign();
    if (condition !== undefined && (!marker.test(condition) || option.test(condition)))
      throw foreign();
    current = normalizePypiName(rawName);
    if (versions.has(current)) throw foreign();
    versions.set(current, canonicalPypiVersion(version));
    hashes.set(current, []);
    continued = true;
  }
  if (continued) throw foreign();
  const root = normalizePypiName(ref.name);
  if (!versions.has(root) || versions.get(root) !== canonicalPypiVersion(ref.version))
    throw mismatch();
  if (digests) {
    const known = new Set(digests.map((digest) => String(digest).toLowerCase()));
    if (!hashes.get(root).every((digest) => known.has(digest))) throw mismatch();
  }
  const dependencies = [...versions]
    .map(([name, version]) => ({ name, version, path: name }))
    // Code-unit order: normalised names (`[a-z0-9-]`) and no host locale involved.
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { digest: lockDigest(text), dependencies };
}
