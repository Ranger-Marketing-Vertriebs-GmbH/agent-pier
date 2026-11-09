import path from "node:path";
import { patchPaths } from "./patch-paths.js";

// Path helpers the file guards share (tool-guard.js, attachment-guard.js).

// Every file-changing tool in OpenClaw's fs section (2026.10.3 tool catalog: ls,
// read, write, edit, apply_patch). apply_patch is implied wherever write is
// allowed (writeAllowsApplyPatch), so it is guarded like write.
export const writeTools = ["write", "edit", "apply_patch"];
/** The tool call's targets, each as classifyWrite sees a single-path call. */
export function writeTargets(toolName, params) {
  if (toolName !== "apply_patch") return [params];
  const paths = patchPaths(params?.input);
  return paths ? paths.map((target) => ({ path: target })) : [{}];
}
// The OpenClaw 2026.10.3 file tools repair model-corrupted paths after this hook runs
// (agent-tools.before-tool-call.decision: XML arg_value suffix, Office extensions);
// every repaired spelling is classified, not only the raw one.
export function repairs(value) {
  const forms = new Set([value, value.trim()]);
  for (const form of [...forms]) {
    let stripped = form;
    while (/<\/arg_value>>+$/.test(stripped))
      stripped = stripped.replace(/<\/arg_value>>+$/, "");
    forms.add(stripped);
  }
  for (const form of [...forms]) {
    forms.add(
      form.replace(
        /\.(doc|ppt|xls)(?:odex|codex|xodex|xcodex)$/i,
        (_m, family) => `.${family.toLowerCase()}x`,
      ),
    );
    // OpenClaw resolves "@name" to "name" when no literal "@name" exists.
    if (form.startsWith("@")) forms.add(form.slice(1));
  }
  return [...forms];
}
// The agent's own workspace folder below the workspaces root (runtime id ap-<id>).
export const workspaceId = (agentId) =>
  typeof agentId === "string" && /^ap-[A-Za-z0-9-]{1,100}$/.test(agentId)
    ? agentId.slice(3)
    : null;
// Workspace-relative POSIX path, or null when the target cannot be proven to stay
// inside the calling agent's own workspace.
export function relativeTarget(raw, roots, ownId) {
  // No workspace file needs a control or line-separator character; a path holding
  // one may be read differently by another parser, so it is never a target.
  if (!raw || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(raw)) return null;
  let target = raw.replaceAll("\\", "/");
  if (!target || /^(@|~|file:)/i.test(target)) return null;
  if (path.posix.isAbsolute(target)) {
    const inside = roots
      .map((root) => path.posix.relative(root, path.posix.normalize(target)))
      .find((rel) => rel && !rel.startsWith("../") && rel !== "..");
    const [own, ...rest] = inside?.split("/") || [];
    // A sibling agent's workspace is never a valid target.
    if (!ownId || own !== ownId) return null;
    target = rest.join("/");
    if (!target) return null;
  }
  target = path.posix
    .normalize(target)
    .replace(/^(\.\/)+/, "")
    .replace(/\/$/, "");
  if (!target || target === "." || target.startsWith("../") || target === "..")
    return null;
  return target;
}
