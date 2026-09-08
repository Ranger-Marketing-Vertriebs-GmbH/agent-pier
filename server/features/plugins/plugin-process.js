import { serverMessages } from "../../lib/i18n/de.js";
import { spawn } from "node:child_process";
import { problem } from "../../lib/storage.js";
import { LIMIT, redacted } from "./plugin-schema.js";
export async function executePluginCommand(
  ctx,
  args,
  { closed, accounts, runner, mutationTimeout, listTimeout, processes },
  mutation = false,
) {
  if (closed) throw problem(serverMessages.plugins.serviceStopping, 503);
  accounts.get(ctx.id);
  if (runner)
    return runner(ctx.command, args, {
      env: ctx.env,
      cwd: ctx.cwd,
      timeout: mutation ? mutationTimeout : listTimeout,
    });
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ctx.command, args, {
        cwd: ctx.cwd,
        env: { ...ctx.env, CI: "1", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      reject(problem(redacted(error.message, ctx.env), 502));
      return;
    }
    let output = "",
      errors = "",
      size = 0,
      failure = null,
      killComplete = Promise.resolve();
    const kill = (signal) => {
      try {
        process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {}
      }
    };
    const cancel = (message) => {
      if (failure) return;
      failure = problem(message, 503);
      kill("SIGTERM");
      killComplete = new Promise((resolveKill) => {
        setTimeout(() => {
          kill("SIGKILL");
          resolveKill();
        }, 500);
      });
    };
    let done;
    const completed = new Promise((resolveDone) => {
      done = resolveDone;
    });
    const active = { cancel, completed };
    processes.add(active);
    const timer = setTimeout(
      () => cancel(serverMessages.plugins.commandTimeout),
      mutation ? mutationTimeout : listTimeout,
    );
    timer.unref();
    const collect = (chunk, stderr) => {
      size += chunk.length;
      if (size > LIMIT) {
        cancel(serverMessages.plugins.commandOutputLimit);
        return;
      }
      if (stderr) errors += chunk.toString();
      else output += chunk.toString();
    };
    child.stdout.on("data", (chunk) => collect(chunk, false));
    child.stderr.on("data", (chunk) => collect(chunk, true));
    child.on("error", (error) => {
      failure = problem(redacted(error.message, ctx.env), 502);
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      await killComplete;
      processes.delete(active);
      done();
      if (failure) return reject(failure);
      if (code !== 0)
        return reject(
          problem(
            redacted(errors || output, ctx.env) || serverMessages.plugins.commandFailed,
            502,
          ),
        );
      resolve(args.includes("--help") ? `${output}\n${errors}` : output);
    });
  });
}
