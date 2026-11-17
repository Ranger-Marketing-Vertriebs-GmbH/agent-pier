import { assistantProblem } from "./assistant-validation.js";
import { runtimeFor } from "./runtimes/runtime-for.js";
import { runtimePagesOf } from "./runtimes/runtime-options.js";

// An agent's memory wiki, read only, for the owner (ADR 0007, step 7b): the routes
// GET /api/assistants/:id/wiki and /wiki/page read it through the agentFiles sub-port
// of the agent's runtime (agent-runtime.js wikiPages, wikiPage), never from the
// vault on disk. Only an agent whose runtime options switch the page on has one
// (runtime-options.js runtimePagesOf: the owner's own agents); the owner-content
// guard checks privacy as for memory files (owner-content-routes.js).

/** The page id of the wiki among an agent's runtime pages (slot agent.page). */
export const wikiPageId = "wiki";
const maxLookup = 512;

// The agent and its runtime's agentFiles sub-port, or 404 without a wiki.
function wikiOf(assistants, id, { runtimeOf }) {
  const agent = assistants.store.getAssistant(id);
  if (!runtimePagesOf(agent).includes(wikiPageId))
    throw assistantProblem("notFound", 404);
  const runtime = runtimeOf ? runtimeOf(agent) : runtimeFor(agent, assistants.runtime);
  if (!runtime.capabilities().memoryWiki?.available)
    throw assistantProblem("notFound", 404);
  assistants.requireReady(agent);
  return { agent, files: runtime.agentFiles };
}

// A call of the sub-port; a failure says only that the wiki is unavailable now.
async function read(call) {
  try {
    return await call();
  } catch {
    throw assistantProblem("unavailable", 503);
  }
}

/**
 * The pages of agent `id`'s wiki: `{ state, totalPages, truncated, pages: [{ lookup,
 * title, kind, updatedAt }] }`. `options.runtimeOf(agent)` replaces the agent's
 * runtime (tests).
 */
export function wikiPages(assistants, id, options = {}) {
  return assistants.admit(async () => {
    const { agent, files } = wikiOf(assistants, id, options);
    return read(() => files.wikiPages({ agentId: agent.runtimeAgentId }));
  });
}

/** One page of agent `id`'s wiki by `lookup` (a listed page's), or 404. */
export function wikiPage(assistants, id, lookup, options = {}) {
  return assistants.admit(async () => {
    if (typeof lookup !== "string" || !lookup || lookup.length > maxLookup)
      throw assistantProblem("invalid");
    const { agent, files } = wikiOf(assistants, id, options);
    const page = await read(() =>
      files.wikiPage({ agentId: agent.runtimeAgentId, lookup }),
    );
    if (!page) throw assistantProblem("notFound", 404);
    return page;
  });
}
