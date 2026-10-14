import { packageProblem } from "./package-errors.js";

export const registries = ["npm"];
const invalid = () => packageProblem("MCP_PACKAGE_INVALID", 400);
// npm's rules: lowercase, URL-safe, optional @scope/, at most 214 characters.
const npmName = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
// An exact semantic version; no range, tag or build alias.
const npmVersion =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const names = { npm: (name) => name.length <= 214 && npmName.test(name) };
const versions = { npm: (version) => version.length <= 256 && npmVersion.test(version) };

export function packageName({ registry, name } = {}) {
  if (!registries.includes(registry) || typeof name !== "string") throw invalid();
  if (!names[registry](name)) throw invalid();
  return name;
}

export function packageRef(input = {}) {
  const name = packageName(input);
  const { registry, version } = input;
  if (typeof version !== "string" || !versions[registry](version)) throw invalid();
  return { registry, name, version };
}
