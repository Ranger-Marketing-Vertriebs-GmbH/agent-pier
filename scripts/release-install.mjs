import { isMainModule } from "../server/lib/is-main-module.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Releases } from "../server/features/operations/releases.js";
import { folder } from "../server/features/operations/files.js";
import {
  installLauncher,
  switchRelease,
} from "../server/features/operations/release-activation.js";
import { checkHealth } from "../server/features/operations/release-service.js";
import { runService } from "./service.mjs";
export { ensureDependencies } from "./install-dependencies.mjs";
import { ensureDependencies } from "./install-dependencies.mjs";
export async function installRelease(
  { archive, installRoot, dataDir, channel, installDependencies = true, service = false },
  {
    run,
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
export async function runInstaller(args, dependencies = {}) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (
      [
        "--service",
        "--install-dependencies",
        "--skip-dependencies",
        "--dependencies-only",
      ].includes(key)
    )
      options[key] = true;
    else if (
      ["--archive", "--install-root", "--data-dir", "--channel"].includes(key) &&
      args[i + 1] &&
      !args[i + 1].startsWith("--")
    )
      options[key] = args[++i];
    else throw Error("Invalid installer option.");
  }
  if (
    options["--skip-dependencies"] &&
    (options["--install-dependencies"] || options["--dependencies-only"])
  )
    throw Error(
      "--skip-dependencies cannot be combined with dependency installation options.",
    );
  if (options["--dependencies-only"]) {
    if (
      Object.keys(options).some(
        (key) => !["--dependencies-only", "--install-dependencies"].includes(key),
      )
    )
      throw Error(
        "--dependencies-only cannot be combined with release or service options.",
      );
    const result = await ensureDependencies(dependencies);
    return { installedDependencies: result.installed };
  }
  return installRelease(
    {
      archive: options["--archive"],
      installRoot: options["--install-root"],
      dataDir: options["--data-dir"],
      channel: options["--channel"],
      service: options["--service"] === true,
      installDependencies: options["--skip-dependencies"] !== true,
    },
    dependencies,
  );
}
if (isMainModule(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runInstaller(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
