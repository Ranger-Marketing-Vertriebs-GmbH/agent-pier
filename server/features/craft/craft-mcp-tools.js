import { createHash } from "node:crypto";
import { z } from "zod";
import { serverMessages } from "../../lib/i18n/de.js";
import { craftStacks } from "./craft-stacks.js";
import { pictureLimits } from "./rebuild-pictures.js";
import { sessionPictureReader, stagePictures } from "./caller-pictures.js";

export const craftInstruction =
  "`craft_rebuild_start` starts a Craft Anything rebuild that runs inside AgentPier; the owner answers its questions there and follows it at the returned link. Poll `craft_rebuild_status` sparingly.";

export const craftTools = {
  craft_rebuild_start: {
    description: `Start a Craft Anything rebuild of an app, a website or a file in AgentPier. Give a request and optionally a target (a web address or an absolute path), a stack (one of: ${craftStacks.join(", ")}) and pictures: up to ${pictureLimits.count} screenshots or photos of the original (PNG, JPEG, WebP or GIF, at most 20 MB each), as paths inside this session's working folder, which show the look the owner expects. Pictures without a target rebuild from the pictures alone. Reuse requestId when you retry the same start; it returns the same rebuild. ${craftInstruction}`,
    schema: z.strictObject({
      request: z.string().min(1).max(8000),
      target: z.string().max(2048).optional(),
      stack: z.string().max(100).optional(),
      pictures: z.array(z.string().min(1).max(4096)).max(pictureLimits.count).optional(),
      requestId: z.string().min(1).max(100),
    }),
    readOnly: false,
  },
  craft_rebuild_status: {
    description:
      "Read the status of a rebuild started with craft_rebuild_start: its status, step, note, folder and how many questions wait for the owner. The owner answers questions in AgentPier.",
    schema: z.strictObject({ id: z.string().min(1).max(100) }),
    readOnly: true,
  },
};

/** Offered to a full session grant only, and only while Craft Anything is installed. */
export function craftToolEntries(grant, context, services) {
  return grant.allResources &&
    context?.sessionId &&
    services?.craftRebuilds &&
    services.craft?.state().installed
    ? Object.entries(craftTools)
    : [];
}

const messages = serverMessages.craft;
const craftError = (code, message, status) =>
  Object.assign(new Error(message), { code, status });

/** What a session or an agent reads of a rebuild: never its questions' details. */
export const statusView = (rebuild) => ({
  id: rebuild.id,
  name: rebuild.name,
  status: rebuild.status,
  statusLabel: rebuild.statusLabel,
  step: rebuild.step,
  note: rebuild.note,
  projectId: rebuild.projectId,
  folder: rebuild.folder,
  openQuestions: rebuild.questions.length,
  link: `/craft/${rebuild.id}`,
});

/**
 * A session's retry key, scoped to the session like the agents' one: the same
 * requestId from another session starts a rebuild of its own. A key over the
 * supervisor's 200 characters is hashed.
 */
function sessionRequestId(sessionId, { requestId }) {
  const key = `${sessionId}:${requestId}`;
  if (key.length <= 200) return key;
  return `${String(sessionId).slice(0, 100)}:${createHash("sha256").update(key).digest("hex")}`;
}

/**
 * The session's pictures, staged (rebuild-pictures.js): only files of its own working
 * folder, read like an agent's shared file (caller-pictures.js), so a session hands
 * Craft Anything nothing it could not read itself.
 */
async function sessionPictures(services, sessionId, paths) {
  if (!paths?.length) return [];
  const session = await services.sessions.get(sessionId);
  const { dataDir } = services.config;
  return stagePictures(
    services.craftRebuilds.pictures,
    paths,
    sessionPictureReader(session.cwd, dataDir),
  );
}

export async function callCraftTool(services, name, input, context) {
  // The grant is checked on every call: a revoked session starts nothing more.
  const unavailable = () =>
    craftError("CRAFT_REBUILD_UNAVAILABLE", serverMessages.previews.accessRevoked, 403);
  if (!context?.sessionId || !services.sessionMcp?.grantFor(context.sessionId))
    throw unavailable();
  if (!services.craftRebuilds || !services.craft?.state().installed)
    throw craftError("CRAFT_REBUILD_UNAVAILABLE", messages.notInstalled, 409);
  const parsed = craftTools[name].schema.safeParse(input);
  if (!parsed.success)
    throw craftError("CRAFT_REBUILD_INVALID_INPUT", messages.rebuildToolInvalid, 400);
  const revalidate = () => {
    try {
      context.revalidate?.();
    } catch {
      throw unavailable();
    }
  };
  revalidate();
  if (name === "craft_rebuild_status") {
    const rebuild = services.craftRebuilds.get(parsed.data.id);
    if (!rebuild)
      throw craftError("CRAFT_REBUILD_NOT_FOUND", messages.rebuildNotFound, 404);
    return statusView(rebuild);
  }
  const { pictures: paths, ...fields } = parsed.data;
  let started, pictures;
  try {
    pictures = await sessionPictures(services, context.sessionId, paths);
    revalidate();
    started = await services.craftRebuilds.start(
      {
        ...fields,
        ...(pictures.length && { pictures }),
        requestId: sessionRequestId(context.sessionId, parsed.data),
      },
      { source: "session" },
    );
  } catch (error) {
    if (error.status) error.code ??= "CRAFT_REBUILD_REFUSED";
    throw error;
  } finally {
    services.craftRebuilds.pictures?.release(pictures);
  }
  revalidate();
  return {
    id: started.id,
    project: { id: started.projectId, name: started.name, folder: started.folder },
    status: started.status,
    link: `/craft/${started.id}`,
  };
}
