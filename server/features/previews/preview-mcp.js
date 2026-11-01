import { z } from "zod";
import { problem } from "../../lib/storage.js";
import { previewError } from "./preview-errors.js";

export const previewInstruction =
  "When you start a server for the user to look at or test, call `preview_open` with its port and give the user the returned link instead of a localhost URL. Bind the server to 127.0.0.1 or localhost. Close it with `preview_close` when it is no longer needed.";

const port = z.number().int().min(1).max(65535);

export const previewTools = {
  preview_open: {
    description: `Open a link for the user to a web server this session runs on a local port. Optional label names the preview and path (starting with /) is the page to open; reopening a port updates its label and path. ${previewInstruction}`,
    schema: z.strictObject({
      port,
      label: z.string().min(1).max(80).optional(),
      path: z.string().min(1).max(2048).optional(),
    }),
    readOnly: false,
  },
  preview_close: {
    description:
      "Close one of this session's previews by its id or by its server port (exactly one of both).",
    schema: z.strictObject({ id: z.string().max(80).optional(), port: port.optional() }),
    readOnly: false,
  },
  preview_list: {
    description: "List this session's open previews with their ids, links and ports.",
    schema: z.strictObject({}),
    readOnly: true,
  },
};

export function previewToolEntries(grant, context) {
  return grant.allResources && context?.sessionId ? Object.entries(previewTools) : [];
}

const unavailable = () =>
  problem("AgentPier access revoked or session unavailable.", 403);
const view = ({ id, url, port, label }) => ({ id, url, port, label });

export async function callPreviewTool(services, name, input, context) {
  // The grant is checked on every call: a revoked session opens nothing more.
  if (!context?.sessionId || !services.sessionMcp?.grantFor(context.sessionId))
    throw unavailable();
  const parsed = previewTools[name].schema.safeParse(input);
  if (!parsed.success) throw previewError("PREVIEW_INVALID_INPUT", 400);
  const revalidate = () => {
    try {
      context.revalidate?.();
    } catch {
      throw unavailable();
    }
  };
  revalidate();
  const { previews } = services;
  const sessionId = context.sessionId;
  const mine = () => previews.list({ sessionId });
  if (name === "preview_list") {
    const items = mine().map((preview) => ({
      id: preview.id,
      url: previews.previewUrl(preview),
      port: preview.target,
      label: preview.label,
    }));
    return { items };
  }
  if (name === "preview_close") {
    const { id, port } = parsed.data;
    if ((id === undefined) === (port === undefined))
      throw previewError("PREVIEW_INVALID_INPUT", 400);
    const found = mine().find((preview) =>
      id === undefined ? preview.target === port : preview.id === id,
    );
    if (!found) throw previewError("PREVIEW_NOT_FOUND", 404);
    return previews.close(found.id, { reason: "tool", source: "mcp" });
  }
  const session = await services.sessions.get(sessionId);
  const result = await previews.open({
    owner: { kind: "session", sessionId, project: session.cwd },
    ...parsed.data,
  });
  revalidate();
  return view(result);
}
