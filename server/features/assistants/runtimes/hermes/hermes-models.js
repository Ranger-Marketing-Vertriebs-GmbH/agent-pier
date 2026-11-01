import { boundPort, reachable, unsupported } from "./hermes-connection.js";

/**
 * The models sub-port (agent-runtime.js) of one Hermes agent. The agent's model is
 * AgentPier's model connection, compiled into its home (hermes-config/model.js); a
 * model switch is a config.apply that restarts the agent's own process set.
 *
 * - catalog({ refresh }): Hermes's model inventory for the agent's home, its
 *   `model.options { explicit_only, refresh }` answer (gateway/session_config.py
 *   model_options) as Hermes gives it.
 * - status(): `{ providers: [] }`. AgentPier signs no model account into a Hermes
 *   home and Hermes adopts none from the host (`auth.adopt_external_logins: false`).
 * - probe, login, loginStep, cancelLogin, logout: refused (UNSUPPORTED). Account
 *   sign-ins are host-wide and OpenClaw's (model-accounts.js); a ChatGPT account's
 *   refresh token is never shared with Hermes (hermes-config/model.js).
 */
export const hermesModels = (supervisor) => boundPort(modelsOver, supervisor);

function modelsOver(current) {
  const refuse = (method) => async () => {
    reachable(current());
    throw unsupported(method);
  };
  return {
    async catalog({ refresh = false, timeoutMs } = {}) {
      const { client } = reachable(current());
      return client.call(
        "model.options",
        { explicit_only: true, ...(refresh ? { refresh: true } : {}) },
        { ...(timeoutMs ? { timeoutMs } : {}) },
      );
    },
    async status() {
      reachable(current());
      return { providers: [] };
    },
    probe: refuse("models.probe"),
    login: refuse("models.login"),
    loginStep: refuse("models.loginStep"),
    cancelLogin: refuse("models.cancelLogin"),
    logout: refuse("models.logout"),
  };
}
