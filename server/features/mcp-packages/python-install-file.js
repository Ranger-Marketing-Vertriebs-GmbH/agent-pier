// The top release file a PyPI install is expected to use, shown with its digest in
// the confirmation. Wheels are ranked the way uv/pip order compatible tags; host OS
// versions (the newest macOS or glibc the host supports) are not modelled.

const minor = 14; // CPython 3.14, the managed toolchain
const machine = { arm64: ["arm64", "aarch64"], x64: ["x86_64", "amd64"] };

/** `name-1.0(-build)-py3-none-any.whl` → its tag sets (compressed tags split on "."). */
function wheelTags(filename) {
  const parts = filename.replace(/\.whl$/, "").split("-");
  if (parts.length < 5) return null;
  const [pythons, abis, platforms] = parts.slice(-3).map((tag) => tag.split("."));
  return { pythons, abis, platforms };
}

/** Python 3 minor of `cp3X`/`py3X`; `py3` alone is any Python 3 (null). */
const pythonMinor = (tag, prefix) => {
  const match = new RegExp(`^${prefix}3(\\d*)$`).exec(tag);
  if (!match) return undefined;
  return match[1] === "" ? null : Number(match[1]);
};

/**
 * [interpreter/abi tier, rank within it] or null when (python, abi) does not run on
 * CPython 3.14. Lower is better: cp314-cp314, cp3X-abi3 (newest X first),
 * cp314-none, then py314, py3, py313 … py30 with abi none.
 */
function interpreterRank(python, abi) {
  const cp = pythonMinor(python, "cp");
  if (abi === `cp3${minor}`) return python === `cp3${minor}` ? [0, 0] : null;
  if (abi === "abi3")
    return typeof cp === "number" && cp >= 2 && cp <= minor ? [1, minor - cp] : null;
  if (abi !== "none") return null;
  if (cp === minor) return [2, 0];
  const py = pythonMinor(python, "py");
  if (py === undefined) return null;
  if (py === minor) return [3, 0];
  if (py === null) return [3, 1];
  return py <= minor ? [3, 2 + minor - py] : null;
}

/**
 * Rank of a platform tag on this host, lower is better, or null when it does not fit:
 * the newest OS version first; the exact arch before universal2; plain `linux_*` last.
 * The managed CPython is a glibc build: musllinux wheels do not fit.
 */
function platformRank(tag, { platform, arch }) {
  const names = machine[arch] || [];
  const archOf = (rest) => names.includes(rest);
  if (platform === "darwin") {
    const match = /^macosx_(\d+)_(\d+)_(\w+)$/.exec(tag);
    if (!match) return null;
    const exact = archOf(match[3]);
    if (!exact && match[3] !== "universal2") return null;
    return -(Number(match[1]) * 100 + Number(match[2])) * 2 + (exact ? 0 : 1);
  }
  if (platform === "linux") {
    const legacy = { manylinux1: [2, 5], manylinux2010: [2, 12], manylinux2014: [2, 17] };
    const many = /^manylinux_(\d+)_(\d+)_(\w+)$/.exec(tag);
    if (many) return archOf(many[3]) ? -(Number(many[1]) * 100 + Number(many[2])) : null;
    const old = /^(manylinux1|manylinux2010|manylinux2014)_(\w+)$/.exec(tag);
    if (old) {
      const [major, glibc] = legacy[old[1]];
      return archOf(old[2]) ? -(major * 100 + glibc) : null;
    }
    const plain = /^linux_(\w+)$/.exec(tag);
    return plain && archOf(plain[1]) ? 0 : null;
  }
  return null;
}

/**
 * Best score of a wheel over its compressed tags: [pure, tier, rank, platform].
 * Platform wheels come before pure ones, as in uv's tag priority.
 */
function wheelScore(tags, host) {
  let best = null;
  for (const python of tags.pythons)
    for (const abi of tags.abis)
      for (const plat of tags.platforms) {
        const interpreter = interpreterRank(python, abi);
        const platformScore = plat === "any" ? 0 : platformRank(plat, host);
        if (!interpreter || platformScore === null) continue;
        const score = [plat === "any" ? 1 : 0, ...interpreter, platformScore];
        if (!best || compare(score, best) < 0) best = score;
      }
  return best;
}

function compare(a, b) {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * The file uv is expected to install for the top package on this host: the best
 * ranked fitting wheel, else the sdist (built with the opt-in).
 * `{ filename, sha256 }`, or null when the release has no fitting file.
 */
export function installFile(files, host) {
  host ??= { platform: process.platform, arch: process.arch };
  let chosen = null;
  let best = null;
  for (const file of files) {
    if (file.packagetype !== "bdist_wheel") continue;
    const tags = wheelTags(file.filename);
    const score = tags && wheelScore(tags, host);
    if (score && (!best || compare(score, best) < 0)) {
      chosen = file;
      best = score;
    }
  }
  chosen ??= files.find((file) => file.packagetype === "sdist");
  return chosen ? { filename: chosen.filename, sha256: chosen.sha256 } : null;
}
