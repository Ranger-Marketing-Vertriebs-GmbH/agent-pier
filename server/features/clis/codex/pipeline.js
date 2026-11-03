import { codexSandboxArguments } from "../../../lib/sandbox.js";

/**
 * The arguments of a pipeline turn after the launch's own `args` (a copy this may
 * change): `{ args, permissions }`. Headless args are the complete command line;
 * otherwise `permissions` are the interactive permission arguments added to it.
 */
export function command({ args, mode, resumeNativeId, headless }) {
  let permissions = [];
  if (headless)
    args.push(
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
    );
  else
    permissions = [
      "-c",
      `approval_policy=${JSON.stringify(mode)}`,
      ...codexSandboxArguments(),
    ];
  args.push(...permissions);
  if (headless)
    return {
      args: [
        "exec",
        "--json",
        ...args,
        ...(resumeNativeId ? ["resume", resumeNativeId, "-"] : ["-"]),
      ],
      permissions,
    };
  return { args, permissions };
}

/** Arguments that keep a launch's own permissions for session `id`. */
export const sessionArgs = () => [];

export const promptArgs = (prompt) => ["--", prompt];

/** Reading `codex exec --json` events (see pipelines/native-events.js). */
export const events = {
  nativeId: (event) => event.thread_id,
  failed: () => false,
  progress: () => false,
  completed: (event) => event.type === "turn.completed",
};
