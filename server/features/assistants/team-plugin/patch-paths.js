// The files an apply_patch call touches, read exactly as OpenClaw 2026.10.3 reads the
// patch (src/agents/apply-patch.ts: parsePatchText, parseOneHunk and
// parseUpdateFileChunk in dist/core-coding-tools-*.mjs). The parser is a port that
// keeps only the structure: the same `\r?\n` split, the same trims and the same
// header grammar, so a header OpenClaw applies is a header here.
//
// The guard fails closed: patchPaths returns null (refuse the whole patch) when
// - the input holds any line terminator other than `\n` (`\r`, U+2028, U+2029,
//   U+0085, vertical tab, form feed), which OpenClaw and a regex might split apart;
// - the port rejects the patch, which OpenClaw would reject as well;
// - a line that looks like a header (`***` after trimming) is neither a hunk
//   header the port took nor one of the envelope or end-of-file markers;
// - the headers the port took differ from every header-looking line, so no line
//   a different reading could treat as a header escapes the check.

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CONTEXT = "@@ ";
const EMPTY_CONTEXT = "@@";
const headers = [ADD, DELETE, UPDATE, MOVE];
const foreignTerminator = /[\r\u2028\u2029\u0085\v\f]/;

class Refused extends Error {}
const refuse = () => {
  throw new Refused();
};

function boundaries(lines) {
  const strict = (candidate) =>
    candidate[0]?.trim() === BEGIN && candidate.at(-1)?.trim() === END;
  if (strict(lines)) return lines;
  if (lines.length < 4) refuse();
  const first = lines[0];
  const last = lines.at(-1);
  if (
    last &&
    (first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') &&
    last.endsWith("EOF")
  ) {
    const inner = lines.slice(1, -1);
    if (strict(inner)) return inner;
  }
  return refuse();
}

function updateChunk(lines, allowMissingContext) {
  if (!lines.length) refuse();
  let start = 0;
  const first = lines[0];
  if (first === EMPTY_CONTEXT || first.startsWith(CONTEXT)) start = 1;
  else if (!allowMissingContext) refuse();
  if (start >= lines.length) refuse();
  let parsed = 0;
  for (const line of lines.slice(start)) {
    if (line === EOF_MARKER) {
      if (parsed === 0) refuse();
      parsed += 1;
      break;
    }
    const marker = line[0];
    if (!marker || marker === " " || marker === "+" || marker === "-") {
      parsed += 1;
      continue;
    }
    if (parsed === 0) refuse();
    break;
  }
  return start + parsed;
}

// One hunk: its header paths and the lines it consumed.
function hunk(lines) {
  const first = lines[0]?.trim();
  if (first === undefined) refuse();
  if (first.startsWith(ADD)) {
    let consumed = 1;
    for (const line of lines.slice(1))
      if (line.startsWith("+")) consumed += 1;
      else break;
    return { paths: [first.slice(ADD.length)], consumed };
  }
  if (first.startsWith(DELETE))
    return { paths: [first.slice(DELETE.length)], consumed: 1 };
  if (first.startsWith(UPDATE)) {
    const paths = [first.slice(UPDATE.length)];
    let remaining = lines.slice(1);
    let consumed = 1;
    const move = remaining[0]?.trim();
    if (move?.startsWith(MOVE)) {
      paths.push(move.slice(MOVE.length));
      remaining = remaining.slice(1);
      consumed += 1;
    }
    let chunks = 0;
    while (remaining.length) {
      const next = remaining[0];
      if (next.trim() === "") {
        remaining = remaining.slice(1);
        consumed += 1;
        continue;
      }
      if (next.startsWith("***")) break;
      const used = updateChunk(remaining, chunks === 0);
      chunks += 1;
      remaining = remaining.slice(used);
      consumed += used;
    }
    if (!chunks) refuse();
    return { paths, consumed };
  }
  return refuse();
}

/** Every path the patch names, or null when the guard must refuse the patch. */
export function patchPaths(input) {
  if (typeof input !== "string" || foreignTerminator.test(input)) return null;
  try {
    const trimmed = input.trim();
    if (!trimmed) refuse();
    const lines = boundaries(trimmed.split(/\r?\n/));
    const paths = [];
    let remaining = lines.slice(1, -1);
    while (remaining.length) {
      const next = hunk(remaining);
      paths.push(...next.paths);
      remaining = remaining.slice(next.consumed);
    }
    // Every header-looking line must be a header the port took, or a marker.
    const looksLike = [];
    for (const line of lines.slice(1, -1)) {
      const t = line.trim();
      if (!t.startsWith("***")) continue;
      const header = headers.find((m) => t.startsWith(m));
      if (header) looksLike.push(t.slice(header.length));
      else if (t !== EOF_MARKER) refuse();
    }
    if (
      !paths.length ||
      looksLike.length !== paths.length ||
      looksLike.some((p, n) => p !== paths[n])
    )
      refuse();
    return paths;
  } catch (error) {
    if (error instanceof Refused) return null;
    throw error;
  }
}
