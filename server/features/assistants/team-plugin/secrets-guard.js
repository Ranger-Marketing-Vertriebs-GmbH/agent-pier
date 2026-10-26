import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileSpellings } from "./file-urls.js";
import { fold, managedFolder, reachesManaged } from "./managed-folder.js";

// A hook run without the hook's Secrets switch never reads the agent's secrets file
// (.agentpier/secrets.env) with a file tool. A run that can run commands has the file
// removed for its time (agent-hook-runs.js); one that cannot keeps the file in place
// for the agent's other chats, and this hook refuses its reads instead. Only a call
// that names the folder in some spelling asks AgentPier, which answers for the
// calling session alone (AgentHooks.secretsRead): every other chat reads as before.
export const secretsReadTools = ["read", "memory_get", "pdf", "view_image", "image"];
export const secretsRefusal =
  "The agent's secrets are not available in this run. Do not try to read them.";
const pathKeys = ["path", "file_path", "filePath", "pdf", "pdfs", "image", "images"];

// The spellings a file tool may resolve a value to: OpenClaw's path repairs (a
// trailing `</arg_value>`, a leading `@`), a file: URL decoded as OpenClaw decodes it
// (file-urls.js) and a home-relative path.
function pathSpellings(value) {
  const forms = new Set([value, value.trim()]);
  for (const form of [...forms]) {
    const stripped = form.replace(/(<\/arg_value>)+>*$/, "");
    forms.add(stripped);
    if (stripped.startsWith("@")) forms.add(stripped.slice(1));
  }
  for (const form of [...forms]) {
    for (const spelling of fileSpellings(form)) forms.add(spelling);
    if (/^~(\/|\\|$)/.test(form)) forms.add(path.join(os.homedir(), form.slice(1)));
  }
  return [...forms].map((form) => form.replaceAll("\\", "/").normalize("NFKC"));
}

const namesFolder = (form) =>
  form.split("/").some((part) => fold(part) === managedFolder);
const ownId = (agentId) =>
  typeof agentId === "string" && /^ap-[A-Za-z0-9-]{1,100}$/.test(agentId)
    ? agentId.slice(3)
    : null;

/**
 * Whether a file tool call names a secrets folder: by name in any spelling, or on
 * disk through a symbolic or hard link from the agent's own workspace. Throws when
 * a target cannot be resolved (the caller treats that as naming it).
 */
export function namesSecrets(params, { roots = [], agentId } = {}) {
  const values = pathKeys.flatMap((key) =>
    Array.isArray(params?.[key]) ? params[key] : [params?.[key]],
  );
  const id = ownId(agentId);
  const workspace = id && roots.length ? path.join(roots[0], id) : null;
  let real = null;
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const form of pathSpellings(value)) {
      if (namesFolder(form)) return true;
      if (!workspace) continue;
      const target = path.resolve(workspace, form);
      let resolved;
      try {
        resolved = fs.realpathSync(target);
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
        throw error;
      }
      if (namesFolder(resolved.replaceAll("\\", "/"))) return true;
      real ??= fs.realpathSync(workspace);
      const relative = path.relative(real, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      if (reachesManaged(real, relative)) return true;
    }
  }
  return false;
}

/** Lets a read of the secrets folder through only where AgentPier allows it. */
export async function secretsCall(event, ctx, bridge, roots) {
  let named;
  try {
    named = namesSecrets(event?.params, { roots, agentId: ctx?.agentId });
  } catch {
    named = true;
  }
  if (!named) return undefined;
  const response = await bridge(
    "/secrets-policy",
    {
      agentId: ctx?.agentId,
      ...(typeof ctx?.sessionKey === "string" && { sessionKey: ctx.sessionKey }),
    },
    ctx?.abortSignal,
  ).catch(() => null);
  const policy = response?.ok ? await response.json().catch(() => null) : null;
  if (policy?.allow === true) return undefined;
  return { block: true, blockReason: secretsRefusal };
}
