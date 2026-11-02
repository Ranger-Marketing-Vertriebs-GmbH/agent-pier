import { boundPort } from "./openclaw-agents.js";
import {
  readStoredProfile,
  removeAccessProfile,
  takeStoredProfile,
  writeAccessProfile,
} from "./openclaw-access-profiles.js";

// OpenClaw keeps model accounts host-wide, under its default agent.
const agentId = "main";

/**
 * The models sub-port (agent-runtime.js) over OpenClaw's model catalog, its account
 * sign-ins and their login wizard. Answers are OpenClaw's own (`models.list`,
 * `models.authStatus` `{ providers }`, `models.probe` `{ status }`, wizard steps
 * `{ done, status, step }`); `timeoutMs` bounds the call, `probeTimeoutMs` the probe
 * OpenClaw runs.
 *
 * AgentPier-held ChatGPT logins (model-logins/chatgpt-vault.js) reach OpenClaw as
 * access-only profiles (openclaw-access-profiles.js), written into its store whether
 * or not the Gateway runs:
 * - writeAccess({ profileId, credential }): writes the profile, then reloads a
 *   running Gateway (`models.authRefresh`). Resolves `{ reloaded }`.
 * - removeAccess({ profileId }): removes it, then reloads a running Gateway.
 * - readStored({ profileId }): OpenClaw's own stored credential of the profile,
 *   refresh token included, or null.
 * - takeStored({ profileId }): the same, and in the same transaction the profile
 *   loses its refresh token (the one move of a login to AgentPier); reloads a
 *   running Gateway. Resolves `{ credential, reloaded }`.
 */
export const openClawModels = (supervisor, clientOf) =>
  boundPort((current) => modelsOver(current, supervisor), supervisor, clientOf);

function modelsOver(current, supervisor) {
  const call = async (...args) => current().call(...args);
  const reload = async (operation) => {
    const client = current();
    if (!client?.ready) return false;
    await client.call("models.authRefresh", { operation, agentId }, { timeoutMs: 30000 });
    return true;
  };
  return {
    catalog: ({ provider, refresh, timeoutMs }) =>
      call(
        "models.list",
        { agentId, provider, view: "all", ...(refresh ? { refresh } : {}) },
        { timeoutMs },
      ),
    status: ({ timeoutMs }) => call("models.authStatus", { agentId }, { timeoutMs }),
    probe: ({ provider, profileId, probeTimeoutMs, timeoutMs }) =>
      call(
        "models.probe",
        { provider, agentId, profileId, timeoutMs: probeTimeoutMs },
        { timeoutMs },
      ),
    logout: ({ provider, profileIds, timeoutMs }) =>
      call("models.authLogout", { provider, agentId, profileIds }, { timeoutMs }),
    // A sign-in runs as a wizard session `sessionId`: login starts it, loginStep
    // answers the step shown (`answer`, or none) and returns the next.
    login: ({ sessionId, authChoice, timeoutMs }) =>
      call("models.authLogin", { sessionId, agentId, authChoice }, { timeoutMs }),
    loginStep: ({ sessionId, answer, timeoutMs }) =>
      call("wizard.next", { sessionId, ...(answer ? { answer } : {}) }, { timeoutMs }),
    cancelLogin: ({ sessionId, timeoutMs }) =>
      call("wizard.cancel", { sessionId, closeInput: true }, { timeoutMs }),
    writeAccess: async ({ profileId, credential }) => {
      writeAccessProfile(supervisor.paths.state, profileId, credential);
      return { reloaded: await reload("update") };
    },
    removeAccess: async ({ profileId }) => {
      removeAccessProfile(supervisor.paths.state, profileId);
      return { reloaded: await reload("logout") };
    },
    readStored: async ({ profileId }) =>
      readStoredProfile(supervisor.paths.state, profileId),
    takeStored: async ({ profileId }) => {
      const credential = takeStoredProfile(supervisor.paths.state, profileId);
      return { credential, reloaded: credential ? await reload("update") : false };
    },
  };
}
