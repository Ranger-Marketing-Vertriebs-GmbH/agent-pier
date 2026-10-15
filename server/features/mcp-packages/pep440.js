const parts =
  /^(?:(\d+)!)?(\d+(?:\.\d+)*)(?:(a|b|rc)(\d+))?(?:\.post(\d+))?(?:\.dev(\d+))?$/i;
const preRank = { a: 0n, b: 1n, rc: 2n };
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The PEP 440 sort key of a version `pypiVersionPattern` accepts (BigInt: no size limit). */
function key(version) {
  const [, epoch = "0", release, pre, preNumber, post, dev] = parts.exec(version);
  const numbers = release.split(".").map(BigInt);
  while (numbers.length > 1 && numbers.at(-1) === 0n) numbers.pop();
  return {
    epoch: BigInt(epoch),
    release: numbers,
    // A dev release of a final sorts before its prereleases; a final after them.
    pre: pre
      ? [preRank[pre.toLowerCase()], BigInt(preNumber)]
      : post === undefined && dev !== undefined
        ? [-1n, 0n]
        : [3n, 0n],
    post: post === undefined ? -1n : BigInt(post),
    dev: dev === undefined ? null : BigInt(dev),
  };
}

/** Ascending PEP 440 order. */
export function comparePep440(a, b) {
  const x = key(a);
  const y = key(b);
  if (x.epoch !== y.epoch) return compare(x.epoch, y.epoch);
  for (let i = 0; i < Math.max(x.release.length, y.release.length); i++) {
    const diff = compare(x.release[i] ?? 0n, y.release[i] ?? 0n);
    if (diff) return diff;
  }
  for (let i = 0; i < 2; i++) {
    const diff = compare(x.pre[i], y.pre[i]);
    if (diff) return diff;
  }
  if (x.post !== y.post) return compare(x.post, y.post);
  if (x.dev === y.dev) return 0;
  if (x.dev === null) return 1;
  if (y.dev === null) return -1;
  return compare(x.dev, y.dev);
}
