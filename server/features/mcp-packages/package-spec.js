import { packageProblem } from "./package-errors.js";

export const registries = ["npm", "pypi"];
const invalid = () => packageProblem("MCP_PACKAGE_INVALID", 400);
// npm's rules: lowercase, URL-safe, optional @scope/, at most 214 characters.
const npmName = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
// An exact semantic version; no range, tag or build alias.
const npmVersion =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
// PEP 508 project names; stored in their PEP 503 normalised form.
const pypiName = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/;
export const normalizePypiName = (name) => name.replace(/[-_.]+/g, "-").toLowerCase();
// A public PEP 440 version, exact: no specifier, wildcard, marker or local part.
export const pypiVersionPattern =
  /^(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/i;
/** The spelling uv writes into a lock: lowercase, no leading zeros in numbers. */
export const canonicalPypiVersion = (version) =>
  version.toLowerCase().replace(/(^|[.!]|a|b|rc|post|dev)0+(?=\d)/g, "$1");
/** A listable/storable PyPI version: PEP 440 public form, at most 128 characters. */
export const isPypiVersion = (version) =>
  version.length <= 128 && pypiVersionPattern.test(version);
const names = {
  npm: (name) => name.length <= 214 && npmName.test(name),
  pypi: (name) => pypiName.test(name),
};
const versions = {
  npm: (version) => version.length <= 256 && npmVersion.test(version),
  pypi: isPypiVersion,
};

export function packageName({ registry, name } = {}) {
  if (!registries.includes(registry) || typeof name !== "string") throw invalid();
  if (!names[registry](name)) throw invalid();
  return registry === "pypi" ? normalizePypiName(name) : name;
}

export function packageRef(input = {}) {
  const name = packageName(input);
  const { registry, version } = input;
  if (typeof version !== "string" || !versions[registry](version)) throw invalid();
  return { registry, name, version };
}

// D4 constraint lines: a PyPI name and comma-separated version limits, nothing else
// (no URL, path, `@`, extra, marker, option, hash, comment or `===`). Spaces and tabs
// only; `~=` needs two release segments and no wildcard (PEP 440).
const release = String.raw`\d+(?:\.\d+)*`;
const suffix = String.raw`(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?`;
const clause = String.raw`(?:(?:==|!=)[ \t]*${release}${suffix}(?:\.\*)?|~=[ \t]*\d+(?:\.\d+)+${suffix}|(?:<=|>=|<|>)[ \t]*${release}${suffix})`;
const constraintLine = new RegExp(
  String.raw`^([A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?)[ \t]*(${clause}(?:[ \t]*,[ \t]*${clause})*)$`,
  "i",
);
export const constraintLimits = Object.freeze({ count: 10, length: 100 });
const invalidConstraints = () =>
  packageProblem("MCP_PACKAGE_INVALID", 400, "invalidConstraints");

/**
 * The owner's dependency constraints of a PyPI source (D4) in their canonical form
 * (normalised name, no spaces): `FastMCP >= 3, < 4` → `fastmcp>=3,<4`. npm has none.
 */
export function packageConstraints(input = {}, ref) {
  const lines = input?.constraints === undefined ? [] : input.constraints;
  if (!Array.isArray(lines)) throw invalidConstraints();
  if (ref.registry !== "pypi") {
    if (lines.length) throw invalidConstraints();
    return [];
  }
  if (lines.length > constraintLimits.count) throw invalidConstraints();
  const seen = new Set();
  return lines.map((line) => {
    if (typeof line !== "string" || line.length > constraintLimits.length)
      throw invalidConstraints();
    const match = constraintLine.exec(line.replace(/^[ \t]+|[ \t]+$/g, ""));
    if (!match) throw invalidConstraints();
    const name = normalizePypiName(match[1]);
    // The top package has its exact version already; a name twice is ambiguous.
    if (name === normalizePypiName(ref.name) || seen.has(name))
      throw invalidConstraints();
    seen.add(name);
    return `${name}${match[2].replace(/[ \t]+/g, "").toLowerCase()}`;
  });
}
