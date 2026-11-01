import path from "node:path";
import { execFile as nodeExecFile } from "node:child_process";

/**
 * The arguments of a `tailscale` call; `AGENTPIER_TAILSCALE_SOCKET` selects another
 * tailscaled and must be an absolute path without control characters.
 */
export function tailscaleArgs(args, env = process.env) {
  const socket = env.AGENTPIER_TAILSCALE_SOCKET;
  if (socket && (!path.isAbsolute(socket) || /[\x00-\x1f]/.test(socket)))
    throw Error("Tailscale socket must be an absolute path.");
  return [...(socket ? [`--socket=${socket}`] : []), ...args];
}

/** Runs the Tailscale CLI; resolves its stdout, rejects with `stderr` on the error. */
export async function runTailscale(
  args,
  { env = process.env, execFile = nodeExecFile } = {},
) {
  const argv = tailscaleArgs(args, env);
  return new Promise((resolve, reject) =>
    execFile(
      "tailscale",
      argv,
      { encoding: "utf8", timeout: 30000, env },
      (error, stdout, stderr) =>
        error ? reject(Object.assign(error, { stderr })) : resolve(stdout),
    ),
  );
}
