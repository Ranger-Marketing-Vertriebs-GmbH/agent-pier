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
const names = {
  npm: (name) => name.length <= 214 && npmName.test(name),
  pypi: (name) => pypiName.test(name),
};
const versions = {
  npm: (version) => version.length <= 256 && npmVersion.test(version),
  pypi: (version) => version.length <= 128 && pypiVersionPattern.test(version),
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
