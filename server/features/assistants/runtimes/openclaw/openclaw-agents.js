import { agentCreateTimeoutMs } from "./gateway-client.js";
import { configWrite } from "./live-patch.js";
import { waitForAgentInRoster } from "./agent-roster.js";
import {
  admissionDone,
  degradedAgents,
  noteRefusal,
  pendingAdmission,
  settledAdmission,
} from "./agent-admission.js";

// Binds the methods `over(current)` builds to the supervisor's client of each call,
// with `on(connection)` binding them to the client behind a handle of
// host.connection() (openclaw-sessions.js explains the bound view).
export const boundPort = (over, supervisor, clientOf) => ({
  ...over(() => supervisor.client),
  on: (connection) => Object.freeze(over(() => clientOf(connection))),
});

/**
 * The agents sub-port (agent-runtime.js): OpenClaw's agent roster. agents.create,
 * agents.update and agents.delete write OpenClaw's configuration, so each waits for
 * the connection's admission and runs after every earlier configuration write on it
 * (live-patch.js `configWrite`), on the one client it started on. The admission
 * state is per connection (agent-admission.js). Answers are OpenClaw's own
 * (`{ agents }`, `{ agentId }`).
 */
export const openClawAgents = (supervisor, clientOf) =>
  boundPort(agentsOver, supervisor, clientOf);

function agentsOver(current) {
  const call = async (...args) => current().call(...args);
  // One client for the wait and the write, as the write is serialized on it.
  const write = async (method, params, ...options) => {
    const client = current();
    return configWrite(client, () => client.call(method, params, ...options));
  };
  return {
    list: () => call("agents.list", {}),
    create: ({ name, workspace, model }) =>
      write(
        "agents.create",
        { name, workspace, model },
        { timeoutMs: agentCreateTimeoutMs },
      ),
    update: ({ agentId, name, model }) =>
      write("agents.update", { agentId, name, model }),
    delete: ({ agentId, deleteFiles }) =>
      write("agents.delete", { agentId, deleteFiles }),
    // Resolves once the roster names `agentId` (a new agent loads after its write).
    waitListed: async ({ agentId, ...options }) =>
      waitForAgentInRoster(current(), agentId, options),
    // Resolves once the runtime admitted the agents it prepares; never rejects.
    settled: async () => settledAdmission(current()),
    // Resolves once every agent was admitted or refused: true when it admitted any.
    admitted: async () => admissionDone(current()),
    // The runtime agent ids the connection refused to admit (synchronous).
    degraded: () => new Set(degradedAgents(current())),
    // Records an admission refusal a call reported; returns it, or null.
    noteRefusal: ({ error }) => noteRefusal(current(), error),
    // The refusal only says the Gateway still inspects the agent's database.
    admitting: (refusal) => refusal?.code === pendingAdmission,
  };
}

/**
 * The agentFiles sub-port: an agent's workspace files the Gateway serves
 * (AGENTS.md, MEMORY.md, …) and its memory search. `get` answers `{ file }` with
 * OpenClaw's `content`, `hash` or `missing`; `set` writes only over the expected
 * hash or absence it is given.
 */
export const openClawAgentFiles = (supervisor, clientOf) =>
  boundPort(agentFilesOver, supervisor, clientOf);

function agentFilesOver(current) {
  const call = async (...args) => current().call(...args);
  return {
    get: ({ agentId, name }) => call("agents.files.get", { agentId, name }),
    set: ({ agentId, name, content, expectedHash, expectedMissing }) =>
      call("agents.files.set", {
        agentId,
        name,
        content,
        ...(expectedHash !== undefined && { expectedHash }),
        ...(expectedMissing !== undefined && { expectedMissing }),
      }),
    // OpenClaw's memory_search tool in the agent's main session. tools.invoke builds
    // only the Gateway's own tools (2026.10.9 tools-invoke-shared: no file tools, and
    // no view_image or pdf without an agent directory) yet checks the full allowlists,
    // so the Gateway logs once that read, write, edit, view_image and pdf are unknown
    // there. An agent's turns build them all; the names are OpenClaw's own.
    searchMemory: ({ agentId, query, maxResults }) =>
      call("tools.invoke", {
        name: "memory_search",
        agentId,
        sessionKey: `agent:${agentId}:main`,
        args: { query, maxResults },
      }),
  };
}
