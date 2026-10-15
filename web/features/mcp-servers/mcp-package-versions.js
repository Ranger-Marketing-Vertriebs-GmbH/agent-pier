// Version choices of a package as the registry lists them (newest first).

/** The newest stable version: the `latest` tag unless it names a prerelease. */
export function newestStable({ latest, versions = [] }) {
  const tagged = versions.find((v) => v.version === latest);
  if (tagged && !tagged.prerelease && !tagged.yanked) return tagged.version;
  const stable = versions.filter((v) => !v.prerelease);
  // Deprecated (npm) and yanked (PyPI) releases are only the last resort.
  return (
    (stable.find((v) => !v.deprecated && !v.yanked) || stable[0] || versions[0])
      ?.version || ""
  );
}

/** Prereleases only when shown, or the one already selected. */
export const versionOptions = (versions, { showPrereleases, selected } = {}) =>
  versions.filter((v) => showPrereleases || !v.prerelease || v.version === selected);
