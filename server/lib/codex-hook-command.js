import { shellQuote } from "./launch-serialization.js";

// Codex trusts the exact command definition. Resolve release-specific paths from
// the host-controlled launch environment so an app update preserves that trust.
export function codexHookCommand(env, name, script, args = []) {
  if (!["BINDING", "AGENTBUS"].includes(name)) throw Error("Unknown managed hook");
  const variable = `AGENTPIER_${name}_HOOK`;
  env.AGENTPIER_HOOK_NODE = process.execPath;
  env[variable] = script;
  return [
    '"${AGENTPIER_HOOK_NODE:?}"',
    `"\${${variable}:?}"`,
    ...args.map(shellQuote),
  ].join(" ");
}
