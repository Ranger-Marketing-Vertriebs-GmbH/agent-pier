import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

  const installRoot =
    values["--install-root"] ||
    env.AGENTPIER_INSTALL_ROOT ||
    path.join(home, ".local/share/agentpier-app");
  const dataDir =
    values["--data-dir"] ||
    env.AGENTPIER_DATA_DIR ||
    path.join(home, "Library/Application Support/AgentPier");
  if (!path.isAbsolute(installRoot) || !path.isAbsolute(dataDir))
    throw Error("Setup paths must be absolute.");
  const relativeData = path.relative(path.resolve(installRoot), path.resolve(dataDir));
  if (!relativeData || (!relativeData.startsWith("..") && !path.isAbsolute(relativeData)))
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
  const args = [
    "--install-root",
    options.installRoot,
    "--data-dir",
    options.dataDir,
    "--resume",
    "--initial-channel",
    `https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/download/v${version}/`,
  ];
  if (options.service) args.push("--service");
  if (!options.installDependencies) args.push("--skip-dependencies");
  return args;
}

if (process.env.AGENTPIER_SETUP_RUN === "1") {
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
