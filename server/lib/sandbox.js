import { tomlValue } from "./launch-serialization.js";
import { cliDefinition, isCodingCli } from "../features/clis/catalog.js";

/**
 * Codex is the only native CLI AgentPier launches inside an operating-system
 * sandbox, and it starts in `read-only` unless a configuration says otherwise.
 * A read-only sandbox silently ignores additional writable roots: the CLI
 * prints "Ignoring --add-dir (…) because the effective permissions do not
 * allow additional writable roots" and carries on. Every launch that grants an
 * extra root therefore has to pin the sandbox itself, or the grant does
 * nothing while the session still looks healthy.
 */
export const CODEX_SANDBOX_MODE = "workspace-write";

/** The `-c` override pair that pins a Codex launch to that sandbox. */
export function codexSandboxArguments() {
  return ["-c", `sandbox_mode=${tomlValue(CODEX_SANDBOX_MODE)}`];
}

/**
 * Set on a launch that runs inside nono. macOS refuses a second Seatbelt profile
 * inside nono's ("sandbox-exec: sandbox_apply: Operation not permitted", exit 71),
 * so a Codex with a sandbox of its own could run no command at all. Inside nono,
 * nono is the boundary and Codex runs with `danger-full-access`
 * (codexOuterSandboxArguments); its approval policy stays as the launch mode set it.
 */
export const OUTER_SANDBOX_VARIABLE = "AGENTPIER_OUTER_SANDBOX";

/** The `-c` override pair that turns Codex's own sandbox off inside nono. */
export function codexOuterSandboxArguments() {
  return ["-c", `sandbox_mode=${tomlValue("danger-full-access")}`];
}

/**
 * The sandbox a native run is confined to, published to the agent as
 * AGENTRUNNER_SANDBOX. nono is the outer boundary when a session names a
 * sandbox profile, so it wins over Codex's own sandbox mode. Without one,
 * Claude and OpenCode run under the host user's own file permissions, so
 * "none" is the honest value for them rather than a mode borrowed from
 * Codex's vocabulary. The CLI's own mode is its definition's `nativeSandbox`; a
 * tool that is no coding CLI (the shell) runs unconfined as well.
 */
export function runSandbox(tool, nonoProfile = null) {
  if (nonoProfile) return "nono";
  return (isCodingCli(tool) && cliDefinition(tool).nativeSandbox) || "none";
}
