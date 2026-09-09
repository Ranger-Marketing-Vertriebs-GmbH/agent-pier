import { isMainModule } from "../../lib/is-main-module.js";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCodexProxy } from "./codex-proxy.js";
import { NativeRequestChannel } from "./native-channel.js";
import { stopOwnedGroup } from "../pipelines/native-owned-group.js";

export function appServerArgs(args) {
  const config = [];
  for (let i = 0; i < args.length; i++) {
    if (
      ["-c", "--config", "--enable", "--disable"].includes(args[i]) &&
      args[i + 1] !== undefined
    )
      config.push(args[i], args[++i]);
    else if (/^--(?:config|enable|disable)=/.test(args[i])) config.push(args[i]);
  }
  return [...config, "app-server", "--stdio"];
}
export async function runCodexLaunch(file, { env = process.env } = {}) {
  const launch = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    launch.token !== env.AGENTPIER_REQUEST_TOKEN ||
    !launch.command ||
    !Array.isArray(launch.args)
  )
    throw Error("Invalid Codex request launch");
  const channel = new NativeRequestChannel({ env });
  const keeper = fileURLToPath(new URL("./codex-owned-backend.js", import.meta.url));
  const backend = spawn(process.execPath, [keeper], {
    cwd: launch.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    detached: process.platform !== "win32",
  });
  const backendClosed = new Promise((resolve) => backend.once("close", resolve));
  // Keeper diagnostics must not write over the independently rendered native TUI.
  backend.stderr.resume();
  backend.stdin.on("error", () => {});
  backend.send(
    { command: launch.command, args: appServerArgs(launch.args), cwd: launch.cwd },
    () => {},
  );
  let terminal,
    backendExited = false,
    backendFailed = false,
    ending = false;
  backend.on("message", (message) => {
    if (message.type !== "backend-exit") return;
    if (!ending && message.code !== 0) backendFailed = true;
    backendExited = true;
    terminal?.kill("SIGTERM");
  });
  let backendError;
  backend.on("error", (error) => {
    backendError = error;
  });
  const proxy = await createCodexProxy({
    input: backend.stdout,
    output: backend.stdin,
    channel,
  });
  if (backendError) {
    await proxy.close();
    channel.close();
    throw backendError;
  }
  terminal = spawn(
    launch.command,
    [
      ...launch.args,
      "--remote",
      proxy.url,
      "--remote-auth-token-env",
      "AGENTPIER_CODEX_WS_TOKEN",
    ],
    {
      cwd: launch.cwd,
      env: { ...env, AGENTPIER_CODEX_WS_TOKEN: proxy.authToken },
      stdio: "inherit",
    },
  );
  const stop = (signal) => {
    if (ending) return;
    ending = true;
    terminal.kill(signal);
    stopOwnedGroup(backend);
  };
  // Interactive cancellation goes to the actual TUI; the backend has its own process group.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  process.on("SIGQUIT", ignore);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  backend.on("close", () => {
    if (!ending) {
      backendFailed = true;
      terminal.kill("SIGTERM");
    }
  });
  const code = await new Promise((resolve) => {
    terminal.once("error", () => resolve(127));
    terminal.once("close", (code) => resolve(code ?? 1));
    if (backendExited) terminal.kill("SIGTERM");
  });
  ending = true;
  stopOwnedGroup(backend);
  await proxy.close();
  channel.close();
  await backendClosed;
  process.removeListener("SIGINT", ignore);
  process.removeListener("SIGQUIT", ignore);
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGHUP", stop);
  if (backendFailed)
    process.stderr.write("The native Codex request backend stopped unexpectedly.\n");
  return backendFailed && code === 0 ? 1 : code;
}
if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = await runCodexLaunch(process.argv[2]);
  } catch {
    process.stderr.write("Unable to start the native Codex request bridge.\n");
    process.exitCode = 127;
  }
}
