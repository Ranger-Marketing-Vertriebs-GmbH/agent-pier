import assert from "node:assert/strict";

/**
 * Asserts that `pieces`, in order, reproduce `original` exactly, except for
 * whitespace dropped between two pieces (a part's break) and whitespace alone
 * before the first or after the last piece (which is no message). Returns the
 * separators dropped between pieces so a caller can check them further.
 */
export function assertJoinedAtBreaks(original, pieces) {
  const dropped = [];
  let at = 0;
  for (const [n, piece] of pieces.entries()) {
    let skip = 0;
    while (!original.startsWith(piece, at + skip) && /\s/.test(original[at + skip] ?? ""))
      skip++;
    assert.ok(
      original.startsWith(piece, at + skip),
      `part ${n} does not continue the text at ${at}: ${JSON.stringify(piece.slice(0, 80))}`,
    );
    if (n) dropped.push(original.slice(at, at + skip));
    at += skip + piece.length;
  }
  assert.match(original.slice(at), /^\s*$/, "the parts end where the text ends");
  return dropped;
}
