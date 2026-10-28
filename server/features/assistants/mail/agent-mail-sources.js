import fs from "node:fs";
import path from "node:path";
import { assistantProblem } from "../assistant-validation.js";
import { readShareSource, shareRoots } from "../agent-share-source.js";
import { projectTarget } from "../project-paths.js";
import { personalShell } from "../native-capabilities.js";
import { workspaceContext } from "../workspace-calls.js";
import { localContext } from "../agent-sftp-local.js";
import { fold } from "../team-plugin/tool-guard.js";
import { mailError } from "../../mail/mail-connection.js";
import { attachmentLimits, sha256 } from "../../mail/mail-parts.js";
import { mailFileType } from "../../mail/mail-file-types.js";

// The files an agent may attach to a draft, send or forward (agentpier_mail). The
// sources follow the file access the agent already has: its workspace and the
// project folders granted in the turn's context, read access sufficing; with the
// shell level Full access also any other file on the host its shell could read.
// With approval or without a shell the host stays out of reach: mail adds no way to
// read host files. Refused for every agent: `.git` (any case), AgentPier's data
// directory (mail passwords, sealed secrets) except the agent's own workspace in
// it, symbolic links anywhere on the path and files with a second hard link
// (agent-share-source.js: links are refused, never resolved). When the owner
// approves later, `sourceAllowed` checks each captured source again.

const refused = () => assistantProblem("mailSourceRefused", 403);
const shareErrors = {
  shareOutside: refused,
  projectPathRefused: refused,
  shareNotFound: () => assistantProblem("mailSourceNotFound", 404),
  notFound: () => assistantProblem("mailSourceNotFound", 404),
  shareTooLarge: () => mailError("MAIL_ATTACHMENT_TOO_LARGE"),
  shareEmpty: () => assistantProblem("mailSourceEmpty", 400),
};
const mapped = (error) => shareErrors[error?.key]?.() ?? error;
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return (
    !!relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};
const realpath = (value) => {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return null;
  }
};
// A path inside `root` as configured or as resolved.
const under = (root, target) => {
  const real = realpath(root);
  return within(root, target) || (!!real && within(real, target));
};
const gitPart = (relative) =>
  relative.split(path.sep).some((part) => fold(part) === fold(".git"));

/**
 * Who attaches, decided per call: `ctx` is the turn's workspaceContext, or for a
 * `mail-result` follow-up that has none `{ assistantId, workspaceOnly: true }` (its
 * workspace only); `shell` is a hook run's live effective level, otherwise the
 * agent's own (personalShell: none for user agents and ineligible profiles).
 */
export function fileContext(w, inv, caller) {
  let ctx;
  try {
    ctx = workspaceContext(w, inv);
  } catch (error) {
    if (caller.origin?.kind !== "mail-result") throw error;
    ctx = { assistantId: caller.assistant.id, workspaceOnly: true };
  }
  let shell;
  if (caller.hook) {
    const run = w.a.routines?.hooks?.runOrigin(caller.assistant, inv.sessionKey);
    shell =
      run?.event?.id === caller.origin.eventId ? (run.effective?.shell ?? "off") : "off";
  } else shell = personalShell(w.a.store.getAssistant(ctx.assistantId));
  return { ctx, shell };
}

function levels(w, ctx) {
  return ctx.workspaceOnly ? {} : w.folders.levels(ctx);
}

function project(w, ctx, projectId) {
  if (typeof projectId !== "string" || !levels(w, ctx)[projectId])
    throw assistantProblem("projectFolderNotGranted", 403);
  try {
    return w.s.memory.project(projectId);
  } catch {
    throw assistantProblem("projectFolderNotGranted", 403);
  }
}

// The file read through readShareSource with the shared refusals: no `.git` part
// and, outside the workspace, nothing inside AgentPier's data directory.
async function read(w, roots, requested, { maxBytes, dataDir = true }) {
  const data = (dataDir ? w.folders.protectedRoots : [])
    .flatMap((root) => [path.resolve(root), realpath(root)])
    .filter(Boolean);
  const admit = (relative) => {
    const target = path.join(realpath(roots[0]) ?? roots[0], relative);
    if (gitPart(relative)) throw refused();
    if (data.some((root) => target === root || within(root, target))) throw refused();
  };
  return readShareSource(roots, requested, { maxBytes, admit });
}

async function fromProject(w, files, projectId, requested, maxBytes) {
  const found = project(w, files.ctx, projectId);
  // The folder's own refusals (`.git`, protected roots) before the read.
  const target = projectTarget(found.cwd, requested, {
    protectedRoots: w.folders.protectedRoots,
  });
  if (!target.exists) throw assistantProblem("mailSourceNotFound", 404);
  const file = await read(w, [found.cwd], requested, { maxBytes });
  return {
    file,
    source: {
      kind: "project",
      projectId,
      projectName: found.name ?? null,
      path: target.relative,
    },
  };
}

function workspaceRoot(w, ctx) {
  const workspaces = w.a.attachments?.config?.workspaces;
  if (!workspaces) throw assistantProblem("unavailable", 503);
  return shareRoots(workspaces, { id: ctx.assistantId })[0];
}

async function fromWorkspace(w, files, requested, maxBytes) {
  const root = workspaceRoot(w, files.ctx);
  // The workspace lies inside AgentPier's data directory: only its own `.git` and
  // AgentPier's managed folder (readShareSource) are refused there.
  const file = await read(w, [root], requested, { maxBytes, dataDir: false });
  const real = realpath(root) ?? root;
  const target = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(root, requested);
  const relative = within(root, target)
    ? path.relative(root, target)
    : path.relative(real, target);
  return {
    file,
    source: { kind: "workspace", path: relative.split(path.sep).join("/") },
  };
}

async function fromHost(w, requested, maxBytes) {
  const file = await read(w, ["/"], requested, { maxBytes });
  return { file, source: { kind: "host", path: path.resolve(requested) } };
}

async function resolveSource(w, files, { path: requested, projectId }, maxBytes) {
  if (projectId !== undefined)
    return fromProject(w, files, projectId, requested, maxBytes);
  if (!path.isAbsolute(requested)) return fromWorkspace(w, files, requested, maxBytes);
  const target = path.resolve(requested);
  if (under(workspaceRoot(w, files.ctx), target))
    return fromWorkspace(w, files, requested, maxBytes);
  for (const id of Object.keys(levels(w, files.ctx))) {
    let cwd;
    try {
      cwd = w.s.memory.project(id).cwd;
    } catch {
      continue;
    }
    if (under(cwd, target)) return fromProject(w, files, id, requested, maxBytes);
  }
  if (files.shell === "full") return fromHost(w, requested, maxBytes);
  throw refused();
}

const validPath = (value) =>
  typeof value === "string" &&
  !!value.trim() &&
  value.length <= 4096 &&
  !/[\u0000-\u001f\u007f-\u009f\p{Zl}\p{Zp}]/u.test(value);

/**
 * One attachment source `{ path, projectId? }`, read within `maxBytes`: `{ name,
 * bytes, size, type, sha256, source }`, `source` naming where it came from
 * (`workspace` or `project` with a relative path, `host` with the absolute one).
 */
export async function readSource(w, files, entry, { maxBytes }) {
  if (!validPath(entry?.path)) throw assistantProblem("invalid");
  if (entry.projectId !== undefined && typeof entry.projectId !== "string")
    throw assistantProblem("invalid");
  let resolved;
  try {
    resolved = await resolveSource(w, files, entry, maxBytes);
  } catch (error) {
    throw mapped(error);
  }
  const { file, source } = resolved;
  return {
    name: file.name,
    bytes: file.body,
    size: file.body.length,
    type: mailFileType(file.name),
    sha256: sha256(file.body),
    source,
  };
}

const sourceKey = (source) =>
  JSON.stringify([source.kind, source.projectId ?? null, source.path]);

/**
 * The listed sources, read one after the other within `maxBytes` in all
 * (MAIL_ATTACHMENT_TOO_LARGE). More than `attachmentLimits.files` entries, or the
 * same file named twice (also once relative and once absolute), is invalid input.
 */
export async function readSources(
  w,
  files,
  list,
  { maxBytes = attachmentLimits.mailBytes } = {},
) {
  if (!Array.isArray(list) || list.length > attachmentLimits.files)
    throw assistantProblem("invalid");
  const named = new Set(list.map((e) => JSON.stringify([e?.projectId ?? null, e?.path])));
  if (named.size !== list.length) throw assistantProblem("invalid");
  const read = [],
    seen = new Set();
  let total = 0;
  for (const entry of list) {
    const left = maxBytes - total;
    if (left <= 0) throw mailError("MAIL_ATTACHMENT_TOO_LARGE");
    const file = await readSource(w, files, entry, { maxBytes: left });
    const key = sourceKey(file.source);
    if (seen.has(key)) throw assistantProblem("invalid");
    seen.add(key);
    total += file.size;
    read.push(file);
  }
  return read;
}

/**
 * What an approval checks again later: the turn's local context (localContext, or
 * the workspace-only marker) and the shell level at capture.
 */
export function storedFiles(files) {
  return {
    context: files.ctx.workspaceOnly
      ? { assistantId: files.ctx.assistantId, workspaceOnly: true }
      : localContext(files.ctx),
    shell: files.shell,
  };
}

/**
 * Whether a captured source is still allowed when the owner approves: the
 * workspace always; a project while the stored context still holds it; a host file
 * only while the agent and the capture both have Full access. Never throws.
 */
export function sourceAllowed(w, assistantId, stored, source) {
  try {
    if (source?.kind === "workspace") return true;
    if (source?.kind === "project")
      return (
        !stored.context.workspaceOnly &&
        !!w.folders.levels(stored.context)[source.projectId]
      );
    if (source?.kind === "host")
      return (
        personalShell(w.a.store.getAssistant(assistantId)) === "full" &&
        stored.shell === "full"
      );
  } catch {}
  return false;
}
