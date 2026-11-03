import { fileURLToPath } from "node:url";
import { ADAPTER_URL_PLACEHOLDER } from "../../providers/adapter-launch.js";
import { answerHookTrust } from "../../requests/codex-hook-trust.js";

/** How the chat shows one app-server question. */
export const question = (q) => ({
  multiple: false,
  allowOther: q.isOther === true || !q.options?.length,
  previews: false,
  notes: false,
});

export const shellToolName = "item/commandExecution/requestApproval";
export const startupDialogs = { codexHookTrust: answerHookTrust };

/**
 * Starts Codex through codex-launch.js, which relays its app-server requests. Returns
 * the replacement launch; `grants` receives what the wrapper must be able to run.
 */
export async function prepareRequests({ file, args, env, grants }, launch) {
  const wrapper = fileURLToPath(
    new URL("../../requests/codex-launch.js", import.meta.url),
  );
  // codex-launch.js starts Codex from the request file, which the launcher never
  // rewrites. The launcher substitutes env values, so the wrapper learns the bound
  // adapter origin from this variable and replaces the placeholder in Codex argv.
  if (args.some((arg) => String(arg).includes(ADAPTER_URL_PLACEHOLDER)))
    env.AGENTPIER_ADAPTER_URL = ADAPTER_URL_PLACEHOLDER;
  // This wrapper replaces the launch command outright, so it must be runnable.
  // The nono adapter grants whatever `launch.command` names by then, which is
  // the wrapper's interpreter rather than Codex, so the original executable
  // is declared here: codex-launch.js starts it again from the request file
  // for both the backend and the TUI.
  grants.push(
    { access: "read", path: launch.command },
    { access: "read", path: process.execPath },
    { access: "read", path: wrapper },
  );
  return { ...launch, command: process.execPath, args: [wrapper, file], env };
}
