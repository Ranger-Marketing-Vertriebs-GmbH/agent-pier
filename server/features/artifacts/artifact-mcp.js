import { z } from "zod";
import { projectScope } from "../memory/project-scope.js";
import { artifactError } from "./artifact-errors.js";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
export const artifactTools = {
  artifact_publish: {
    description:
      "Publish private HTML or an image from this session's workspace. For a folder include entrypoint. HTML may use bundled CSS, images, fonts, classic JS and local ES modules; no network APIs, workers, import.meta or computed resource URLs. Limits: 50 MiB, 500 files. Reuse requestId and identical arguments after an uncertain result. artifactId updates this session's artifact at the same URL. Session deletion removes unpinned artifacts; owner pin/delete controls are in AgentPier. Never publish secrets or an entire repository.",
    schema: z.strictObject({
      requestId: id,
      title: z.string().min(1).max(100),
      sourcePath: z.string().min(1).max(4096),
      entrypoint: z.string().min(1).max(1024).optional(),
      artifactId: id.optional(),
    }),
    readOnly: false,
  },
  artifacts_list: {
    description:
      "List this session's published artifacts, including IDs for updates and private browser URLs.",
    schema: z.strictObject({ page: z.number().int().min(1).max(100000).optional() }),
    readOnly: true,
  },
};
export function artifactToolEntries(grant, context) {
  return grant.allResources && context?.sessionId ? Object.entries(artifactTools) : [];
}
const denials = new Set(["ARTIFACT_ACCESS_DENIED", "ARTIFACT_PROJECT_CHANGED"]);
export async function callArtifactTool(services, name, input, grant, context) {
  try {
    return await performArtifactTool(services, name, input, grant, context);
  } catch (error) {
    if (denials.has(error.code))
      services.audit.append({
        action: "artifact.denied",
        resourceType: "artifact",
        ...(validId(input?.artifactId) ? { resourceId: input.artifactId } : {}),
        ...(validId(context?.sessionId) ? { sessionId: context.sessionId } : {}),
        source: "mcp",
        outcome: "failure",
      });
    throw error;
  }
}
const validId = (value) => id.safeParse(value).success;
/** The session's current project, after a safe rebind of a folder that became Git. */
async function currentProject(services, session, grant, context) {
  const project = await projectScope(session.cwd);
  const ensure = () =>
    services.projectRebind?.ensure({ cwd: session.cwd, previousIds: grant.projectIds });
  if (grant.projectIds.includes(project.id)) {
    // The Git identity may already be registered by another session, or a move
    // may have been interrupted; finish it so earlier artifacts follow the project.
    await ensure()?.catch(() => null);
    return project;
  }
  const rebound = await ensure();
  if (rebound?.id !== project.id) throw artifactError("ARTIFACT_PROJECT_CHANGED", 409);
  context.revalidate();
  return rebound;
}
async function performArtifactTool(services, name, input, grant, context) {
  if (
    !grant.allResources ||
    !context?.sessionId ||
    typeof context.revalidate !== "function"
  )
    throw artifactError("ARTIFACT_ACCESS_DENIED", 403);
  const parsed = artifactTools[name].schema.safeParse(input);
  if (!parsed.success) throw artifactError("ARTIFACT_INVALID_INPUT");
  context.revalidate();
  const session = await services.sessions.get(context.sessionId);
  const config = services.effectiveConfig?.() || services.config;
  const origin = config.remoteUrl || `http://127.0.0.1:${config.port}`;
  const withUrl = (result) => ({
    ...result,
    url: `${origin}/artifacts/view/${result.id}`,
  });
  if (name === "artifacts_list") {
    const result = await services.artifacts.list({
      sessionId: session.id,
      page: parsed.data.page,
    });
    context.revalidate();
    return { ...result, items: result.items.map(withUrl) };
  }
  const project = await currentProject(services, session, grant, context);
  const result = await services.artifacts.publish(
    { sessionId: session.id, projectId: project.id, cwd: session.cwd },
    parsed.data,
    context.revalidate,
  );
  services.audit.append({
    action: "artifact.updated",
    resourceType: "artifact",
    resourceId: result.id,
    projectId: project.id,
    source: "mcp",
    outcome: "success",
  });
  return withUrl(result);
}
