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
  /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)==(\S+?)(?:\s*;\s*([^;]+?))?\s*\\$/;
// Marker grammar characters only: no `/`, `:`, `@`, `#` or `\` can smuggle a source in.
const marker = /^[A-Za-z0-9_ .'"<>=!~()-]+$/;
const hash = /^--hash=sha256:([0-9a-f]{64})(\s*\\)?$/;

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
    const line = raw.trim();
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
    if (condition !== undefined && !marker.test(condition)) throw foreign();
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
    .sort((a, b) => a.name.localeCompare(b.name));
  return { digest: lockDigest(text), dependencies };
}
