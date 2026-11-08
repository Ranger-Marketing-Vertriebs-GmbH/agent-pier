import { z } from "zod";
import { serverMessages } from "../../lib/i18n/de.js";
import { craftStacks } from "./craft-stacks.js";

export const craftInstruction =
  "`craft_rebuild_start` starts a Craft Anything rebuild that runs inside AgentPier; the owner answers its questions there and follows it at the returned link. Poll `craft_rebuild_status` sparingly.";

export const craftTools = {
  craft_rebuild_start: {
    description: `Start a Craft Anything rebuild of an app, a website or a file in AgentPier. Give a request and optionally a target (a web address or an absolute path) and a stack (one of: ${craftStacks.join(", ")}). Reuse requestId when you retry the same start; it returns the same rebuild. ${craftInstruction}`,
    schema: z.strictObject({
      request: z.string().min(1).max(8000),
      target: z.string().max(2048).optional(),
      stack: z.string().max(100).optional(),
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

const statusView = (rebuild) => ({
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
  let started;
  try {
    started = await services.craftRebuilds.start(parsed.data, {
      source: "session",
    });
  } catch (error) {
    if (error.status) error.code ??= "CRAFT_REBUILD_REFUSED";
    throw error;
  }
  revalidate();
  return {
    id: started.id,
    project: { id: started.projectId, name: started.name, folder: started.folder },
    status: started.status,
    link: `/craft/${started.id}`,
  };
}
