// Bounded historical evidence only: never reconstruct edits from current files.
export const MAX_CHANGE_CHARS = 100000;
export const MAX_CHANGE_ROWS = 2000;
export const validText = (value) =>
  typeof value === "string" && value.length <= MAX_CHANGE_CHARS && !value.includes("\0");
export const validPath = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  !/[\x00-\x1f]/.test(value);
const lines = (value) => {
  const rows = value.replaceAll("\r\n", "\n").split("\n");
  if (rows.at(-1) === "") rows.pop();
  return rows;
};
export function change(path, operation, rows, provenance = "excerpt", extra = {}) {
  if (
    !validPath(path) ||
    rows.length > MAX_CHANGE_ROWS ||
    (extra.movePath && !validPath(extra.movePath))
  )
    return null;
  return {
    path,
    operation,
    provenance,
    rows,
    added: rows.filter((row) => row.kind === "add").length,
    removed: rows.filter((row) => row.kind === "remove").length,
    ...extra,
  };
}
export function replacement(path, before, after) {
  if (!validText(before) || !validText(after)) return null;
  const a = lines(before),
    b = lines(after);
  if (a.length + b.length > MAX_CHANGE_ROWS) return null;
  // The bounded LCS keeps unchanged lines readable without an unbounded diff cost.
  if ((a.length + 1) * (b.length + 1) > 250000) return null;
  const matrix = Array.from(
    { length: a.length + 1 },
    () => new Uint16Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      matrix[i][j] =
        a[i] === b[j]
          ? matrix[i + 1][j + 1] + 1
          : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
  const rows = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ kind: "context", text: a[i++] });
      j++;
    } else if (i < a.length && (j === b.length || matrix[i + 1][j] >= matrix[i][j + 1]))
      rows.push({ kind: "remove", text: a[i++] });
    else rows.push({ kind: "add", text: b[j++] });
  }
  if (before.endsWith("\n") !== after.endsWith("\n"))
    rows.push({
      kind: "meta",
      text: "",
      annotation: after.endsWith("\n") ? "oldNoNewline" : "newNoNewline",
    });
  return change(path, "update", rows);
}
export function codePreview(path, content) {
  if (!validText(content)) return null;
  return change(
    path,
    "write",
    lines(content).map((text) => ({ kind: "context", text })),
    "preview",
  );
}

export function fullFileChange(path, content, operation) {
  if (!validText(content)) return null;
  const rows = lines(content).map((text, index) => ({
    kind: operation === "create" ? "add" : "remove",
    text,
    [operation === "create" ? "newLine" : "oldLine"]: index + 1,
  }));
  if (content && !content.endsWith("\n"))
    rows.push({
      kind: "meta",
      text: "",
      annotation: operation === "create" ? "newNoNewline" : "oldNoNewline",
    });
  return change(path, operation, rows, "full");
}

// A single-file unified patch. Hunk counts must match; incomplete data stays raw.
export function unifiedPatch(path, patch, operation = "update", extra = {}) {
  if (!validText(patch)) return null;
  const source = lines(patch),
    rows = [];
  let old = 0,
    next = 0,
    oldLeft = 0,
    newLeft = 0,
    seen = false;
  for (const line of source) {
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/);
    if (hunk) {
      if (oldLeft || newLeft) return null;
      [old, oldLeft, next, newLeft] = [
        Number(hunk[1]),
        Number(hunk[2] ?? 1),
        Number(hunk[3]),
        Number(hunk[4] ?? 1),
      ];
      if (![old, oldLeft, next, newLeft].every(Number.isSafeInteger)) return null;
      seen = true;
      rows.push({ kind: "meta", text: line });
      continue;
    }
    if (!seen) continue;
    if (line === "\\ No newline at end of file") {
      rows.push({ kind: "meta", text: line });
      continue;
    }
    const kind = { "+": "add", "-": "remove", " ": "context" }[line[0]];
    if (!kind || (!oldLeft && !newLeft)) return null;
    const row = { kind, text: line.slice(1) };
    if (kind !== "add") {
      if (--oldLeft < 0) return null;
      row.oldLine = old++;
    }
    if (kind !== "remove") {
      if (--newLeft < 0) return null;
      row.newLine = next++;
    }
    rows.push(row);
  }
  return seen && !oldLeft && !newLeft
    ? change(path, operation, rows, "patch", extra)
    : null;
}

export function applyPatch(patch) {
  if (!validText(patch)) return [];
  const source = lines(patch);
  if (source.shift() !== "*** Begin Patch" || source.pop() !== "*** End Patch") return [];
  const files = [];
  let current;
  for (const line of source) {
    const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (header) {
      current = {
        path: header[2],
        operation: { Add: "create", Update: "update", Delete: "delete" }[header[1]],
        rows: [],
      };
      files.push(current);
      if (files.length > 30) return [];
      continue;
    }
    if (!current) return [];
    if (line.startsWith("*** Move to: ") && current.operation === "update") {
      current.movePath = line.slice(13);
      if (!validPath(current.movePath)) return [];
      current.operation = "rename";
      continue;
    }
    if (line === "*** End of File" || line.startsWith("@@")) {
      current.rows.push({ kind: "meta", text: line });
      continue;
    }
    const kind = { "+": "add", "-": "remove", " ": "context" }[line[0]];
    if (
      !kind ||
      current.operation === "delete" ||
      (current.operation === "create" && kind !== "add")
    )
      return [];
    current.rows.push({ kind, text: line.slice(1) });
  }
  const result = files.map((file) =>
    change(
      file.path,
      file.operation,
      file.rows,
      "excerpt",
      file.movePath ? { movePath: file.movePath } : {},
    ),
  );
  return result.every(Boolean) ? result : [];
}
