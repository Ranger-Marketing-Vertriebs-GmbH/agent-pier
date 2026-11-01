import { boundPort } from "./openclaw-agents.js";

// OpenClaw keeps model accounts host-wide, under its default agent.
const agentId = "main";

/**
 * The models sub-port (agent-runtime.js) over OpenClaw's model catalog, its account
 * sign-ins and their login wizard. Answers are OpenClaw's own (`models.list`,
 * `models.authStatus` `{ providers }`, `models.probe` `{ status }`, wizard steps
 * `{ done, status, step }`); `timeoutMs` bounds the call, `probeTimeoutMs` the probe
 * OpenClaw runs.
 */
export const openClawModels = (supervisor, clientOf) =>
  boundPort(modelsOver, supervisor, clientOf);

function modelsOver(current) {
  const call = async (...args) => current().call(...args);
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
  };
}
