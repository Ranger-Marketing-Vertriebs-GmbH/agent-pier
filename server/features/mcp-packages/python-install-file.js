// The top release file a PyPI install uses, shown with its digest in the confirmation.

const python = { major: 3, minor: 14 };
const machine = { arm64: ["arm64", "aarch64"], x64: ["x86_64", "amd64"] };

/** `name-1.0(-build)-py3-none-any.whl` → its tag sets (compressed tags split on "."). */
function wheelTags(filename) {
  const parts = filename.replace(/\.whl$/, "").split("-");
  if (parts.length < 5) return null;
  const [pythons, abis, platforms] = parts.slice(-3).map((tag) => tag.split("."));
  return { pythons, abis, platforms };
}

const cpythonMinor = (tag) => /^cp3(\d+)$/.exec(tag)?.[1];
const pythonFits = (tag) =>
  tag === "py3" ||
  tag === `py${python.major}${python.minor}` ||
  tag === `cp${python.major}${python.minor}`;
/** abi3 wheels built for an older CPython 3 run on 3.14 as well. */
const abiFits = (abi, pythons) =>
  abi === "none" ||
  abi === `cp${python.major}${python.minor}` ||
  (abi === "abi3" &&
    pythons.some((tag) => Number(cpythonMinor(tag) ?? Infinity) <= python.minor));

function platformFits(tag, { platform, arch }) {
  const names = machine[arch] || [];
  if (platform === "darwin")
    return (
      tag.startsWith("macosx_") &&
      (tag.endsWith("_universal2") || names.some((name) => tag.endsWith(`_${name}`)))
    );
  // The managed CPython is a glibc build: musllinux wheels do not fit.
  if (platform === "linux")
    return /^(?:many)?linux/.test(tag) && names.some((name) => tag.endsWith(`_${name}`));
  return false;
}

function fits(tags, host, { pure }) {
  if (!tags) return false;
  const pythonOk =
    tags.pythons.some(pythonFits) ||
    tags.abis.some((abi) => abi === "abi3" && abiFits(abi, tags.pythons));
  const abiOk = tags.abis.some((abi) => abiFits(abi, tags.pythons));
  const platformOk = pure
    ? tags.platforms.includes("any")
    : tags.platforms.some((tag) => platformFits(tag, host));
  return pythonOk && abiOk && platformOk;
}

/**
 * The file uv installs for the top package on this host: its pure wheel, else a
 * platform wheel for CPython 3.14 here, else the sdist (built with the opt-in).
 * `{ filename, sha256 }`, or null when the release has no fitting file.
 */
export function installFile(
  files,
  host = { platform: process.platform, arch: process.arch },
) {
  const wheels = files.filter((file) => file.packagetype === "bdist_wheel");
  const chosen =
    wheels.find((file) => fits(wheelTags(file.filename), host, { pure: true })) ||
    wheels.find((file) => fits(wheelTags(file.filename), host, { pure: false })) ||
    files.find((file) => file.packagetype === "sdist");
  return chosen ? { filename: chosen.filename, sha256: chosen.sha256 } : null;
}
