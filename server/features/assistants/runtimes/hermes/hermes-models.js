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
 * - probe, login, loginStep, cancelLogin, logout, writeAccess, removeAccess,
 *   readStored: refused (UNSUPPORTED). Account sign-ins are host-wide and
 *   AgentPier's (model-accounts.js); a Hermes agent reaches a ChatGPT account through
 *   AgentPier's model proxy and never holds its tokens (hermes-config/model.js).
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
    // AgentPier's ChatGPT logins reach Hermes through the model proxy instead
    // (hermes-config/model.js), never as a profile in its home.
    writeAccess: refuse("models.writeAccess"),
    removeAccess: refuse("models.removeAccess"),
    readStored: refuse("models.readStored"),
  };
}
