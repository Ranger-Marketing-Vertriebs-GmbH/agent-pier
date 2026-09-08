import fs from "node:fs";
import { fileURLToPath } from "node:url";
export const applicationRoot = fileURLToPath(new URL("../../../", import.meta.url));
export function applicationVersion() {
  const release = new URL("../../../release.json", import.meta.url);
  const source = new URL("../../../package.json", import.meta.url);
  return JSON.parse(fs.readFileSync(fs.existsSync(release) ? release : source, "utf8"))
    .version;
}

// Release versions use numeric core components and SemVer prerelease precedence.
export function compareReleaseVersions(left, right) {
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
