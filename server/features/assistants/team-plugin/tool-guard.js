import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
// Files OpenClaw loads into every prompt as agent instructions. Native tools may
// never rewrite them; AgentPier owns AGENTS.md and the owner edits USER.md.
export const bootstrapFiles = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
];
export const writeTools = ["write", "edit"];
// Must stay below AgentPier's tolerance for a missing report after reconnecting.
export const guardReportMs = 15000;
// Approximates the case-insensitive, normalization-insensitive lookup of APFS:
// "AGENTſ.md" (U+017F) and the Kelvin sign U+212A fold to ASCII here.
const fold = (name) => name.normalize("NFKC").toUpperCase().toLowerCase();
const protectedNames = new Set(bootstrapFiles.map(fold));
// The OpenClaw 2026.9.8 file tools repair model-corrupted paths after this hook runs
// (agent-tools.before-tool-call.decision: XML arg_value suffix, Office extensions);
// every repaired spelling is classified, not only the raw one.
function repairs(value) {
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
function relativeTarget(raw, roots, ownId) {
  if (!raw || raw.includes("\0")) return null;
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
    .replace(/\/+$/, "");
  if (!target || target === "." || target.startsWith("../") || target === "..")
    return null;
  return target;
}
// Root-level names must be plain ASCII so no Unicode fold can reach a bootstrap file.
// Workspace skill folders are loaded into the prompt like bootstrap files, and a
// bootstrap name must never become a directory either.
const protectedFolders = new Set(["skills", ".agents"]);
function protectedName(relative) {
  const [first, ...rest] = relative.split("/");
  return (
    !/^[A-Za-z0-9 ._()+,-]+$/.test(first) ||
    protectedNames.has(fold(first)) ||
    (rest.length > 0 && protectedFolders.has(fold(first)))
  );
}
// Identity of every on-disk bootstrap file, so links and case variants are caught.
function protectedTargets(workspace) {
  const ids = new Set();
  for (const name of fs.readdirSync(workspace))
    if (protectedNames.has(fold(name)))
      try {
        const stat = fs.statSync(path.join(workspace, name));
        ids.add(`${stat.dev}:${stat.ino}`);
      } catch {}
  return ids;
}
export function classifyWrite(params, { roots = [], agentId } = {}) {
  const ownId = workspaceId(agentId);
  const values = [params?.path, params?.file_path, params?.filePath].filter(
    (value) => typeof value === "string",
  );
  if (!values.length || !ownId || !roots.length) return { outside: true };
  const targets = values.flatMap(repairs).map((v) => relativeTarget(v, roots, ownId));
  if (targets.some((t) => !t)) return { outside: true };
  if (targets.some(protectedName)) return { bootstrap: true };
  let workspace;
  try {
    workspace = fs.realpathSync(path.join(roots[0], ownId));
  } catch {
    // No workspace yet: nothing on disk can alias a bootstrap file.
    return { path: targets[0] };
  }
  const ids = protectedTargets(workspace);
  for (const target of targets)
    try {
      const stat = fs.statSync(path.join(workspace, target));
      if (ids.has(`${stat.dev}:${stat.ino}`)) return { bootstrap: true };
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return { outside: true };
    }
  return { path: targets[0] };
}
export function registerToolGuard(api) {
  const configured = api.pluginConfig?.workspaces;
  const roots =
    typeof configured === "string" && path.isAbsolute(configured) ? [configured] : [];
  try {
    if (roots.length) roots.push(fs.realpathSync(roots[0]));
  } catch {}
  const bridge = (endpoint, body, signal) =>
    fetch(api.pluginConfig.url + endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${api.pluginConfig.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    });
  // Setup and metadata loads have no hook surface; registration must never throw.
  if (typeof api.on !== "function") return null;
  api.on(
    "before_tool_call",
    async (event, ctx) => {
      const deny = (blockReason) => ({ block: true, blockReason });
      let target;
      try {
        target = classifyWrite(event.params, { roots, agentId: ctx?.agentId });
      } catch {
        return deny("The write target could not be verified.");
      }
      if (target.outside) return deny("Writes are limited to this agent's workspace.");
      if (target.bootstrap)
        return deny("Agent instruction files are managed by AgentPier.");
      if (!ctx?.sessionKey) return deny("This turn is not authorized to change files.");
      // The bridge alone knows whether the current turn came directly from the owner.
      const response = await bridge(
        "/tool-policy",
        {
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          toolName: event.toolName,
          path: target.path,
        },
        ctx.abortSignal,
      ).catch(() => null);
      const policy = response?.ok ? await response.json().catch(() => null) : null;
      if (policy?.allow === true) return undefined;
      return deny("Only the owner's own messages may change files.");
    },
    { matcher: writeTools, priority: 1000 },
  );
  // Only after the hook is registered, and only from the active Gateway runtime
  // registry: discovery loads never carry the hooks agent runs use.
  if (api.registrationMode !== "full") return null;
  // A managed plugin instance aborts lifecycle.signal when OpenClaw retires it
  // (plugin replacement, reload, Gateway close); a retired registry never reports.
  const signal = api.lifecycle?.signal;
  const instance = randomUUID();
  let timer = null;
  const stop = () => {
    clearInterval(timer);
    timer = null;
  };
  const report = () => {
    if (signal?.aborted) return stop();
    return bridge("/guard", { pid: process.pid, ppid: process.ppid, instance }).catch(
      () => null,
    );
  };
  // AgentPier withdraws the guard whenever its connection leaves ready, so the
  // report repeats, but only while this instance can prove it is still active.
  if (signal instanceof AbortSignal && !signal.aborted) {
    const interval = api.pluginConfig?.guardReportMs;
    timer = setInterval(
      report,
      Number.isSafeInteger(interval) && interval >= 1000 ? interval : guardReportMs,
    );
    timer.unref?.();
    signal.addEventListener("abort", stop, { once: true });
    api.lifecycle.onDispose?.(stop);
  }
  api.on("gateway_stop", stop);
  return report();
}
