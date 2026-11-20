import {
  applyPatch,
  fullFileChange,
  change,
  codePreview,
  replacement,
  unifiedPatch,
  MAX_CHANGE_CHARS,
} from "./file-change-model.js";
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const parse = (value) => {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
};
export function toolFileChanges(name, raw, metadata = {}) {
  metadata = object(metadata);
  const input = object(parse(raw));
  const key = String(name)
    .replace(/^functions\./, "")
    .toLowerCase();
  let files = [];
  if (key === "apply_patch") {
    if (Array.isArray(metadata.files) && metadata.files.length <= 30)
      files = metadata.files.map((file) =>
        unifiedPatch(
          file?.filePath,
          file?.patch,
          { add: "create", update: "update", delete: "delete", move: "rename" }[
            file?.type
          ] || "update",
          file?.movePath ? { movePath: file.movePath } : {},
        ),
      );
    if (!files.length || files.some((file) => !file))
      files = applyPatch(
        typeof raw === "string" && raw.startsWith("*** Begin Patch")
          ? raw
          : input.patchText || input.patch || input.input,
      );
  } else if (["edit", "multiedit"].includes(key)) {
    const path = input.file_path || input.filePath;
    // OpenCode's result diff includes the real file coordinates and formatting.
    const native = unifiedPatch(path, metadata.diff || metadata.filediff?.patch);
    if (native) files = [native];
    else {
      const edits = key === "multiedit" ? input.edits : [input];
      if (Array.isArray(edits) && edits.length <= 30)
        files = edits.map((edit) =>
          replacement(
            path,
            edit?.old_string ?? edit?.oldString,
            edit?.new_string ?? edit?.newString,
          ),
        );
    }
  } else if (key === "write") {
    const path = input.file_path || input.filePath;
    files = [
      unifiedPatch(path, metadata.diff || metadata.filediff?.patch) ||
        codePreview(path, input.content),
    ];
  }
  if (files.some((file) => !file)) return {};
  // Optional additive payload: the original raw tool text is always retained.
  return files.length &&
    files.every(Boolean) &&
    JSON.stringify(files).length <= MAX_CHANGE_CHARS * 2
    ? { fileChanges: files }
    : {};
}
/**
 * A Codex file change's `changes` as a list of `{ path, kind, diff }`. The app-server
 * sends that list; a rollout's `FileChange` item (Codex 0.169) keeps an object keyed
 * by path instead, with `{ type: "update", unified_diff, move_path }` or
 * `{ type: "add" | "delete", content }` (AGENTPIER-404).
 */
export function codexChangeList(changes) {
  if (Array.isArray(changes)) return changes;
  if (!changes || typeof changes !== "object") return [];
  return Object.entries(changes).map(([path, value]) => {
    const item = object(value);
    const type = typeof item.type === "string" ? item.type : "update";
    const movePath = typeof item.move_path === "string" ? item.move_path : null;
    return {
      path,
      kind: movePath ? { type, move_path: movePath } : type,
      diff:
        type === "update"
          ? typeof item.unified_diff === "string"
            ? item.unified_diff
            : ""
          : typeof item.content === "string"
            ? item.content
            : "",
    };
  });
}
export function codexFileChanges(raw) {
  const changes = codexChangeList(raw);
  if (!changes.length || changes.length > 30) return {};
  const files = changes.map((item) => {
    const kind = typeof item?.kind === "string" ? item.kind : item?.kind?.type;
    if (kind === "add" || kind === "delete")
      return fullFileChange(item.path, item.diff, kind === "add" ? "create" : "delete");
    const movePath = item?.kind?.move_path || item?.kind?.movePath;
    // Codex app-server appends this suffix to an otherwise standard unified diff.
    const suffix = movePath ? `\n\nMoved to: ${movePath}` : "";
    const patch =
      typeof item?.diff === "string" && suffix && item.diff.endsWith(suffix)
        ? item.diff.slice(0, -suffix.length)
        : item?.diff;
    if (movePath && patch === "")
      return change(item.path, "rename", [], "patch", { movePath });
    return unifiedPatch(
      item?.path,
      patch,
      movePath ? "rename" : "update",
      movePath ? { movePath } : {},
    );
  });
  return files.length &&
    files.every(Boolean) &&
    JSON.stringify(files).length <= MAX_CHANGE_CHARS * 2
    ? { fileChanges: files }
    : {};
}

/** A Codex file change row: its raw text (path and diff per file) and parsed changes. */
export function codexFileChangeRow(raw) {
  const text = codexChangeList(raw)
    .map((change) =>
      [change?.path, change?.diff]
        .filter((part) => typeof part === "string" && part)
        .join("\n\n"),
    )
    .filter(Boolean)
    .join("\n\n");
  return { text, ...codexFileChanges(raw) };
}
