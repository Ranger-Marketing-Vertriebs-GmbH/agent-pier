import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../server/lib/is-main-module.js";
import { installerVersion } from "./installer-package.mjs";

export function resolveSetupOptions(args, { home, env, platform, arch }) {
  if (platform !== "darwin")
    throw Error("AgentPier setup currently supports macOS only.");
  if (!["arm64", "x64"].includes(arch)) throw Error("Unsupported macOS architecture.");

  const values = {};
  const present = new Set();
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (["--no-service", "--skip-dependencies", "--dependencies-only"].includes(option)) {
      present.add(option);
      continue;
    }
    if (["--install-root", "--data-dir"].includes(option)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw Error(`${option} requires a value.`);
      values[option] = value;
      present.add(option);
      continue;
    }
    throw Error(`Unknown setup option: ${option}`);
  }

  if (
    present.has("--dependencies-only") &&
    [...present].some((option) => option !== "--dependencies-only")
  )
    throw Error("--dependencies-only cannot be combined with other setup options.");

  const defaultInstallRoot = path.join(home, ".local/share/agentpier-app");
  const defaultDataDir = path.join(home, "Library/Application Support/AgentPier");
  if (present.has("--dependencies-only"))
    return {
      installRoot: defaultInstallRoot,
      dataDir: defaultDataDir,
      service: true,
      installDependencies: true,
      dependenciesOnly: true,
      resume: true,
    };

  const installRoot =
    values["--install-root"] || env.AGENTPIER_INSTALL_ROOT || defaultInstallRoot;
  const dataDir = values["--data-dir"] || env.AGENTPIER_DATA_DIR || defaultDataDir;
  if (!path.isAbsolute(installRoot) || !path.isAbsolute(dataDir))
    throw Error("Setup paths must be absolute.");
  if (installRoot === path.parse(installRoot).root)
    throw Error("The install root cannot be the filesystem root.");
  if (path.resolve(installRoot) !== installRoot || path.resolve(dataDir) !== dataDir)
    throw Error("Setup requires normalized absolute paths without dot segments.");
  const relativeData = path.relative(path.resolve(installRoot), path.resolve(dataDir));
  if (
    !relativeData ||
    (relativeData !== ".." &&
      !relativeData.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeData))
  )
    throw Error("The data directory must be outside the install root.");

  return {
    installRoot,
    dataDir,
    service: !present.has("--no-service"),
    installDependencies: !present.has("--skip-dependencies"),
    dependenciesOnly: present.has("--dependencies-only"),
    resume: true,
  };
}

export function installerArguments(options, version) {
  if (options.dependenciesOnly) return ["--dependencies-only"];
  const releaseVersion = installerVersion(
    version === undefined
      ? JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
          .version
      : version,
  );
  const args = [
    "--install-root",
    options.installRoot,
    "--data-dir",
    options.dataDir,
    "--resume",
    "--initial-channel",
    `https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/download/v${releaseVersion}/`,
  ];
  if (options.service) args.push("--service");
  if (!options.installDependencies) args.push("--skip-dependencies");
  return args;
}

if (isMainModule(import.meta.url)) {
  try {
    const options = resolveSetupOptions(process.argv.slice(2), {
      home: process.env.HOME,
      env: process.env,
      platform: process.platform,
      arch: process.arch,
    });
    const result = spawnSync(
      "/bin/sh",
      [
        fileURLToPath(new URL("./install.sh", import.meta.url)),
        ...installerArguments(options, process.env.AGENTPIER_SETUP_VERSION),
      ],
      { stdio: "inherit", env: process.env },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
