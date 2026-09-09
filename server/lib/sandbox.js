import { tomlValue } from "./launch-serialization.js";

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
 * The sandbox a native run is confined to, published to the agent as
 * AGENTRUNNER_SANDBOX. Claude and OpenCode run under the host user's own file
 * permissions, so "none" is the honest value for them rather than a mode
 * borrowed from Codex's vocabulary.
 */
export function runSandbox(tool) {
  return tool === "codex" ? CODEX_SANDBOX_MODE : "none";
}
