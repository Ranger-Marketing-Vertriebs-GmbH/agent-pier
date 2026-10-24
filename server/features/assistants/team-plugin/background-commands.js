import { liveProcesses } from "./exec-processes.js";

export const backgroundMethod = "agentpier.backgroundCommands";

/**
 * Registers the method AgentPier asks before it nudges a goal: how many background
 * commands the session has running by the Gateway's record. Admin-only (only
 * AgentPier holds that scope); it answers counts, never ids, commands or output.
 */
export function registerBackgroundCommands(api) {
  api.registerGatewayMethod?.(
    backgroundMethod,
    ({ params, respond }) => {
      const key = params?.sessionKey;
      if (typeof key !== "string" || !key || key.length > 512)
        return respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "invalid background commands request",
        });
      respond(true, liveProcesses(key));
    },
    { scope: "operator.admin" },
  );
}
