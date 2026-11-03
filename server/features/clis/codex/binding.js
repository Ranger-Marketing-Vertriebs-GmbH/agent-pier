// How the native session binding hooks into Codex and finds the thread of a session.
import { parse as parseToml } from "smol-toml";
import { codexHookCommand } from "../../../lib/codex-hook-command.js";
import { tomlValue } from "../../../lib/launch-serialization.js";
import { pidStart } from "../../../../vendor/agentbus/core/proc.js";

/** A missing session id in a hook payload is an error. */
export const idOptional = false;

/**
 * Adds the binding hook (`script --record`) to SessionStart and UserPromptSubmit: into
 * the last `-c hooks.<event>=` override when the launch has one, otherwise as a new
 * override. `fail(key)` builds the session problem named `key`.
 */
export function addHooks(launch, { script, fail }) {
  const { args, env } = launch;
  const hook = {
    hooks: [
      {
        type: "command",
        command: codexHookCommand(env, "BINDING", script, ["--record"]),
        timeout: 5,
      },
    ],
  };
  for (const event of ["SessionStart", "UserPromptSubmit"]) {
    const key = `hooks.${event}=`;
    let index = -1;
    for (let i = 0; i < args.length; i++)
      if (args[i].startsWith(key) && ["-c", "--config"].includes(args[i - 1])) index = i;
    if (index >= 0) {
      let entries;
      try {
        entries = parseToml(args[index]).hooks[event];
      } catch {
        throw fail("codexHooksCannotBeMerged");
      }
      if (!Array.isArray(entries)) throw fail("unknownCodexHookFormat");
      args[index] = key + tomlValue([...entries, hook]);
    } else args.push("-c", key + tomlValue([hook]));
  }
}

/**
 * The thread of the Codex process running in the session's pane, found through the
 * app-server history, or null to fall back to the receipt. `ctx` is the
 * NativeSessionBinding (accounts, sessions, history, processOptions, processCache);
 * `resolveProcess` is native-session-process.js's resolveCodexProcess. A process
 * lookup is cached for 2 s unless `forInput` asks for a fresh one.
 */
export async function resolve(ctx, session, { forInput, receipt, resolveProcess }) {
  if (!(ctx.accounts && ctx.sessions && ctx.history)) return null;
  const cacheKey = JSON.stringify([
    session.id,
    session.accountId,
    session.cwd,
    session.status,
  ]);
  const cached = ctx.processCache.get(cacheKey);
  if (!forInput && cached && Date.now() - cached.time < 2000) {
    if (cached.value) return cached.value;
  } else {
    let value = null;
    try {
      value = await resolveProcess(session, {
        sessions: ctx.sessions,
        accounts: ctx.accounts,
        history: ctx.history,
        ...ctx.processOptions,
        verifyRuntime: receipt
          ? (pid) => pid === receipt.pid && pidStart(pid) === receipt.pidStart
          : undefined,
      });
    } catch {}
    ctx.processCache.set(cacheKey, { time: Date.now(), value });
    if (value) return value;
  }
  return null;
}
