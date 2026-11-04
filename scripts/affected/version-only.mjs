// A release bump changes only the "version" fields of the package manifests; no
// test and no runtime contract depends on them. Free of dependencies, so a CI
// step can use it before `npm ci` (scripts/assistant-runtime-paths.mjs).
const versionFields = {
  "package.json": (json) => ({ ...json, version: undefined }),
  "package-lock.json": (json) => ({
    ...json,
    version: undefined,
    packages: { ...json.packages, "": { ...json.packages?.[""], version: undefined } },
  }),
};

export const versionFiles = Object.keys(versionFields);

// `before` and `after` are the file's texts; anything else is not a version bump.
export function versionOnly(file, before, after) {
  const strip = versionFields[file];
  if (!strip || typeof before !== "string" || typeof after !== "string") return false;
  try {
    return (
      JSON.stringify(strip(JSON.parse(before))) ===
      JSON.stringify(strip(JSON.parse(after)))
    );
  } catch {
    return false;
  }
}
