import path from "node:path";
import { fileURLToPath } from "node:url";
import { patchPaths } from "./patch-paths.js";
// OpenClaw dreaming keeps its raw corpus in memory/.dreams/. No agent file tool
// reads or changes it (the notes under memory/dreaming/ stay open).
export const dreamsTools = ["read", "memory_get", "write", "edit", "apply_patch"];
export const dreamsRefusal = "The dreaming corpus in memory/.dreams/ is closed.";
const corpus = /(^|\/)memory\/\.dreams(\/|$)/;
const canon = (value) =>
  path.posix
    .normalize(
      value
        .trim()
        .replace(/(<\/arg_value>)+>*$/, "")
        .replace(/^@/, "")
        .replaceAll("\\", "/")
        .normalize("NFKC"),
    )
    .toLowerCase();
// OpenClaw decodes file: inputs with fileURLToPath (%2E is "."); both spellings count.
function spellings(value) {
  const forms = [value];
  if (/^\s*file:/i.test(value))
    try {
      forms.push(fileURLToPath(value.trim()));
    } catch {
      // An undecodable file: value is judged as written.
    }
  return forms;
}
/** Refuses a call that names memory/.dreams/ in any spelling, or whose target cannot be read. */
export function dreamsCall(event) {
  const params = event?.params;
  let values;
  if (event?.toolName === "apply_patch") {
    const paths = patchPaths(params?.input);
    if (!paths) return { block: true, blockReason: dreamsRefusal };
    values = paths;
  } else values = [params?.path, params?.file_path, params?.filePath];
  const hit = values.some(
    (v) => typeof v === "string" && spellings(v).some((form) => corpus.test(canon(form))),
  );
  return hit ? { block: true, blockReason: dreamsRefusal } : undefined;
}
