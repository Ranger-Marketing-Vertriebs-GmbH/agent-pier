import { isMainModule } from "../server/lib/is-main-module.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Releases } from "../server/features/operations/releases.js";
import { folder } from "../server/features/operations/files.js";
import {
  installLauncher,
  switchRelease,
} from "../server/features/operations/release-activation.js";
import { checkHealth } from "../server/features/operations/release-service.js";
import { runService } from "./service.mjs";
const execute = promisify(execFile);
export async function ensureDependencies({
  install = false,
  platform = process.platform,
  run = execute,
  env = process.env,
} = {}) {
  const missing = [];
  const runtimeEnv = {
    ...env,
    PATH: [
      env.PATH || "",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(path.delimiter),
  };
  for (const [tool, args] of [
    ["tmux", ["-V"]],
    ["git", ["--version"]],
  ]) {
    try {
      await run(tool, args, { env: runtimeEnv, timeout: 3000 });
    } catch {
      missing.push(tool);
    }
  }
  if (!missing.length) return { installed: [], env: runtimeEnv };
  if (!install)
    throw Error(
      `Missing ${missing.join(", ")}. Re-run with --install-dependencies to explicitly install host prerequisites.`,
    );
  if (platform === "darwin") {
    await run("brew", ["--version"], { env: runtimeEnv, timeout: 3000 });
    await run("brew", ["install", ...missing], {
      env: runtimeEnv,
      timeout: 600000,
      maxBuffer: 1024 * 1024,
    });
  } else if (platform === "linux") {
    await run("sudo", ["-n", "apt-get", "update"], {
      env: runtimeEnv,
      timeout: 300000,
      maxBuffer: 1024 * 1024,
    });
    await run("sudo", ["-n", "apt-get", "install", "-y", ...missing], {
      env: runtimeEnv,
      timeout: 600000,
      maxBuffer: 1024 * 1024,
    });
  } else
    throw Error(
      "Automatic dependency setup supports macOS/Homebrew and Linux/apt. Install tmux and Git with your platform package manager.",
    );
  for (const tool of missing)
    await run(tool, [tool === "tmux" ? "-V" : "--version"], {
      env: runtimeEnv,
      timeout: 3000,
    });
  return { installed: missing, env: runtimeEnv };
}
export async function installRelease(
  {
    archive,
    installRoot,
    dataDir,
    channel,
    installDependencies = false,
    service = false,
  },
  {
    run = execute,
    serviceRunner = runService,
    health = checkHealth,
    releaseOptions = {},
    env = process.env,
    platform = process.platform,
    home = os.homedir(),
  } = {},
) {
  if (
    !installRoot ||
    !dataDir ||
    !path.isAbsolute(installRoot) ||
    !path.isAbsolute(dataDir)
  )
    throw Error("Absolute --install-root and --data-dir paths are required.");
  if (fs.existsSync(path.join(installRoot, "current")))
    throw Error("Versioned installation already exists. Use release-activate instead.");
  const dependencies = await ensureDependencies({
    install: installDependencies,
    platform,
    run,
    env,
  });
  dataDir = folder(dataDir);
  const releases = new Releases({ dataDir, installRoot, channel, ...releaseOptions });
  const staged = archive
    ? await releases.stage({ archive })
    : await releases.stage({ version: (await releases.check()).version });
  const launcher = installLauncher({ installRoot, dataDir });
  switchRelease(installRoot, staged.version);
  const configuredEnv = {
    ...dependencies.env,
    AGENTPIER_INSTALL_ROOT: installRoot,
    AGENTPIER_DATA_DIR: dataDir,
    ...(channel ? { AGENTPIER_RELEASE_CHANNEL: channel } : {}),
  };
  if (service) {
    await serviceRunner({
      action: "install",
      platform,
      home,
      env: configuredEnv,
      config: { dataDir, port: 4380 },
    });
    if (!(await health({ port: 4380, version: staged.version })))
      throw Error(
        "Initial service health check failed. Inspect the service logs and listener configuration; installed release and data were preserved.",
      );
  }
  return {
    version: staged.version,
    installRoot,
    dataDir,
    launcher,
    installedDependencies: dependencies.installed,
    serviceInstalled: service,
  };
}
if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2),
    options = {};
  try {
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      if (["--service", "--install-dependencies"].includes(key)) options[key] = true;
      else if (
        ["--archive", "--install-root", "--data-dir", "--channel"].includes(key) &&
        args[i + 1] &&
        !args[i + 1].startsWith("--")
      )
        options[key] = args[++i];
      else throw Error("Invalid installer option.");
    }
    const result = await installRelease({
      archive: options["--archive"],
      installRoot: options["--install-root"],
      dataDir: options["--data-dir"],
      channel: options["--channel"],
      service: options["--service"] === true,
      installDependencies: options["--install-dependencies"] === true,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
