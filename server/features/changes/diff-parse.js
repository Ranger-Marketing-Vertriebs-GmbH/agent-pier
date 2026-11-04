// Unified git diff parser shared by the server and the browser bundle:
// no Buffer, no node: imports.
export const MAX_DIFF_ROWS = 2000;

const ESCAPES = { t: 9, n: 10, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
const decoder = new TextDecoder();

// Reads a double-quoted C-style string at `start` (which points at the opening
// quote). Octal escapes are raw bytes and are decoded as UTF-8.
function readQuoted(text, start) {
  const bytes = [];
  const encoder = new TextEncoder();
  let i = start + 1;
  while (i < text.length && text[i] !== '"') {
    if (text[i] === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      if (/[0-7]/.test(next)) {
        const octal = /^[0-7]{1,3}/.exec(text.slice(i + 1))[0];
        bytes.push(parseInt(octal, 8) & 0xff);
        i += 1 + octal.length;
        continue;
      }
      if (next in ESCAPES) {
        bytes.push(ESCAPES[next]);
        i += 2;
        continue;
      }
    }
    const code = text.codePointAt(i);
    const char = String.fromCodePoint(code);
    bytes.push(...encoder.encode(char));
    i += char.length;
  }
  return { value: decoder.decode(new Uint8Array(bytes)), end: i + 1 };
}

const unquote = (name) => (name.startsWith('"') ? readQuoted(name, 0).value : name);

// A name from a ---/+++ line: git appends a TAB when the name contains spaces.
function headerName(raw) {
  const name = raw.startsWith('"') ? raw : raw.replace(/\t.*$/, "");
  return unquote(name);
}

const stripPrefix = (name, prefix) => (name.startsWith(prefix) ? name.slice(2) : name);

// The path of a `diff --git` line, used when no other line names the file.
function gitLinePath(rest) {
  if (rest.startsWith('"')) {
    const first = readQuoted(rest, 0);
    return stripPrefix(first.value, "a/");
  }
  const half = (rest.length - 5) / 2;
  if (Number.isInteger(half) && half > 0) {
    const left = rest.slice(2, 2 + half);
    if (rest.startsWith("a/") && rest.slice(2 + half) === ` b/${left}`) return left;
  }
  // Mixed quoting or differing halves (renames): take the b/ side.
  const quoted = rest.indexOf(' "b/');
  if (quoted >= 0) return unquote(rest.slice(quoted + 1)).slice(2);
  const idx = rest.lastIndexOf(" b/");
  return idx >= 0 ? rest.slice(idx + 3) : rest;
}

function newFile(rest) {
  return {
    path: gitLinePath(rest),
    oldPath: null,
    status: "modified",
    binary: false,
    added: 0,
    removed: 0,
    rows: [],
    rowsTruncated: false,
    pathFixed: false,
  };
}

/**
 * @param {string} text
 * @param {{ maxRowsPerFile?: number }} [options]
 */
export function parseGitDiff(text, { maxRowsPerFile = MAX_DIFF_ROWS } = {}) {
  const files = [];
  if (typeof text !== "string" || text === "") return files;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let file = null;
  let inHunk = false;
  let binaryPatch = false;
  let oldLine = 0;
  let newLine = 0;

  const push = (row) => {
    if (file.rows.length >= maxRowsPerFile) file.rowsTruncated = true;
    else file.rows.push(row);
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      file = newFile(line.slice(11));
      files.push(file);
      inHunk = false;
      binaryPatch = false;
      continue;
    }
    if (!file) continue;
    if (inHunk) {
      const body = line.endsWith("\r") ? line.slice(0, -1) : line;
      const mark = line[0];
      if (mark === "\\") {
        push({ kind: "meta", text: body });
        continue;
      }
      if (mark === "+") {
        file.added++;
        push({ kind: "add", text: body.slice(1), newLine: newLine++ });
        continue;
      }
      if (mark === "-") {
        file.removed++;
        push({ kind: "remove", text: body.slice(1), oldLine: oldLine++ });
        continue;
      }
      if (mark === " " || line === "") {
        push({
          kind: "context",
          text: body.slice(1),
          oldLine: oldLine++,
          newLine: newLine++,
        });
        continue;
      }
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk && !binaryPatch) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      push({ kind: "meta", text: line });
      continue;
    }
    inHunk = false;
    if (binaryPatch) continue;
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = unquote(line.slice(12));
    } else if (line.startsWith("rename to ")) {
      file.status = "renamed";
      file.path = unquote(line.slice(10));
      file.pathFixed = true;
    } else if (line.startsWith("copy from ")) {
      file.status = "copied";
      file.oldPath = unquote(line.slice(10));
    } else if (line.startsWith("copy to ")) {
      file.status = "copied";
      file.path = unquote(line.slice(8));
      file.pathFixed = true;
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      file.binary = true;
      binaryPatch = line === "GIT binary patch";
    } else if (line.startsWith("--- ")) {
      const name = headerName(line.slice(4));
      if (name === "/dev/null") file.status = "added";
      else if (!file.pathFixed) file.path = stripPrefix(name, "a/");
    } else if (line.startsWith("+++ ")) {
      const name = headerName(line.slice(4));
      if (name === "/dev/null") file.status = "deleted";
      else if (!file.pathFixed) {
        file.path = stripPrefix(name, "b/");
        file.pathFixed = true;
      }
    }
  }
  for (const f of files) delete f.pathFixed;
  return files;
}
