const validVersion = (version) =>
  typeof version === "string" &&
  version.length <= 80 &&
  /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version);

// Release versions use numeric core components and SemVer prerelease precedence.
function compareReleaseVersions(left, right) {
  if (!validVersion(left) || !validVersion(right))
    return Number(validVersion(left)) - Number(validVersion(right));
  const parts = (value) => {
    const separator = value.indexOf("-");
    return {
      core: (separator < 0 ? value : value.slice(0, separator)).split(".").map(BigInt),
      pre: separator < 0 ? [] : value.slice(separator + 1).split("."),
    };
  };
  const a = parts(left),
    b = parts(right);
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  }
  if (!a.pre.length || !b.pre.length)
    return Number(!a.pre.length) - Number(!b.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === b.pre[i]) continue;
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    const numericA = /^\d+$/.test(a.pre[i]),
      numericB = /^\d+$/.test(b.pre[i]);
    if (numericA !== numericB) return numericA ? -1 : 1;
    const first = numericA ? BigInt(a.pre[i]) : a.pre[i];
    const second = numericB ? BigInt(b.pre[i]) : b.pre[i];
    if (first !== second) return first > second ? 1 : -1;
  }
  return 0;
}

export function releasePresentation(releases, plan) {
  const unique = (items) => [
    ...new Map(items.map((item) => [item.version, item])).values(),
  ];
  const newestFirst = (a, b) => compareReleaseVersions(b.version, a.version);
  const newer = (version) =>
    validVersion(version) &&
    validVersion(releases.current) &&
    compareReleaseVersions(version, releases.current) > 0;
  const staged = unique([...releases.staged].reverse())
    .filter((item) => newer(item.version))
    .sort(newestFirst);
  const stagedVersions = new Set(staged.map((item) => item.version));
  const candidate =
    plan && !plan.upToDate && newer(plan.version) && !stagedVersions.has(plan.version)
      ? plan
      : null;
  const history = unique(releases.releases)
    .map((item) => (validVersion(item.version) ? item : { ...item, canRollback: false }))
    .filter(
      (item) =>
        item.version !== releases.current &&
        !stagedVersions.has(item.version) &&
        item.version !== candidate?.version,
    )
    .sort(newestFirst);
  return { staged, candidate, history };
}
