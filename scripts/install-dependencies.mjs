import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { hostEnvironment } from "../server/lib/host-environment.js";

const execute = promisify(execFile);
// Package managers need the terminal for sudo passwords and installation progress.
function installCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(Error(`${command} failed. Check the package manager output and retry.`));
    });
  });
}

export async function ensureDependencies({
  install = true,
  platform = process.platform,
  run = execute,
  installRun = run === execute ? installCommand : run,
  env = process.env,
  uid = process.getuid?.(),
  interactive = Boolean(process.stdin.isTTY),
} = {}) {
  const runtimeEnv = hostEnvironment(env);
  const probe = (command, args) => run(command, args, { env: runtimeEnv, timeout: 3000 });
  const missing = [];
  for (const [tool, args] of [
    ["tmux", ["-V"]],
    ["git", ["--version"]],
  ]) {
    try {
      await probe(tool, args);
    } catch {
      missing.push(tool);
    }
  }
  if (!missing.length) return { installed: [], env: runtimeEnv };
  if (!install)
    throw Error(
      `Missing ${missing.join(", ")}. Re-run with --install-dependencies or --dependencies-only to install host prerequisites.`,
    );
  const options = { env: runtimeEnv, timeout: 600000 };
  if (platform === "darwin") {
    try {
      await probe("brew", ["--version"]);
    } catch {
      await installRun(
        "/bin/sh",
        [fileURLToPath(new URL("./install-homebrew.sh", import.meta.url))],
        {
          env: runtimeEnv,
          timeout: 1800000,
        },
      );
      try {
        await probe("brew", ["--version"]);
      } catch {
        throw Error(
          "Homebrew is still unavailable after installation. Check its installer output and administrator access, then retry.",
        );
      }
    }
    await installRun("brew", ["install", ...missing], options);
  } else if (platform === "linux") {
    try {
      await probe("apt-get", ["--version"]);
    } catch {
      throw Error(
        `Missing ${missing.join(", ")}. Automatic Linux setup requires apt-get. Install these tools with your package manager, then re-run the installer.`,
      );
    }
    const command = uid === 0 ? "apt-get" : "sudo";
    const prefix = uid === 0 ? [] : [...(interactive ? [] : ["-n"]), "apt-get"];
    try {
      await installRun(command, [...prefix, "update"], options);
      await installRun(command, [...prefix, "install", "-y", ...missing], options);
    } catch {
      throw Error(
        `Could not install ${missing.join(", ")}. Run the installer in a terminal with sudo access, or install these packages as an administrator and retry.`,
      );
    }
  } else {
    throw Error(
      "Automatic dependency setup supports macOS/Homebrew and Linux/apt. Install tmux and Git with your platform package manager.",
    );
  }
  for (const tool of missing) {
    try {
      await probe(tool, [tool === "tmux" ? "-V" : "--version"]);
    } catch {
      throw Error(
        `${tool} is still unavailable after installation. Check its installation and PATH before starting AgentPier.`,
      );
    }
  }
  return { installed: missing, env: runtimeEnv };
}
