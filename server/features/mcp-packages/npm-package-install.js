import fs from "node:fs";
import path from "node:path";
import { proxyEnvironment } from "../../lib/proxy-environment.js";
import { readJSON } from "../../lib/storage.js";
import { runProcessTree } from "./child-process-tree.js";
import { packageError, packageProblem } from "./package-errors.js";
import { privateFolder } from "./verified-files.js";

const failed = () => packageProblem("MCP_PACKAGE_INSTALL_FAILED", 502);
/** Any failure becomes the stable install code: npm output and errors carry paths. */
const wrapped = (error) => packageError(error, "MCP_PACKAGE_INSTALL_FAILED", 502);

export const npmManifestText = (ref) =>
  `${JSON.stringify({ name: "agentpier-mcp-package", private: true, dependencies: { [ref.name]: ref.version } })}\n`;

/** Only proxy variables are inherited (no npm_config_*); config files are empty. */
function npmEnvironment({ work, node, cacheDir, environment }) {
  for (const name of ["home", "tmp"]) privateFolder(path.join(work, name));
  for (const name of ["user.npmrc", "global.npmrc"])
    fs.writeFileSync(path.join(work, name), "", { mode: 0o600 });
  return {
    ...proxyEnvironment(environment),
    HOME: path.join(work, "home"),
    TMPDIR: path.join(work, "tmp"),
    PATH: [path.dirname(node.nodePath), "/usr/bin", "/bin"].join(path.delimiter),
    npm_config_cache: privateFolder(cacheDir),
    npm_config_userconfig: path.join(work, "user.npmrc"),
    npm_config_globalconfig: path.join(work, "global.npmrc"),
    npm_config_update_notifier: "false",
  };
}

async function npm(args, { cwd, node, env, execute, log, signal }) {
  try {
    const { stdout, stderr } = await execute(
      node.nodePath,
      [node.npmCliPath, ...args, "--no-audit", "--no-fund"],
      { cwd, env, timeout: 600000, maxBuffer: 4 * 1024 * 1024, signal },
    );
    log?.(`${stdout}\n${stderr}`);
  } catch (error) {
    log?.(`${error.stdout || ""}\n${error.stderr || ""}`);
    if (signal?.aborted) throw packageProblem("MCP_PACKAGE_CANCELLED", 409);
    throw failed();
  }
}

/** Resolves the exact reference to a lockfile without installing or running scripts. */
export async function resolveNpm({
  stage,
  ref,
  node,
  registry,
  cacheDir,
  execute = runProcessTree,
  environment = process.env,
  log,
  signal,
}) {
  const work = path.join(stage, ".npm-work");
  const project = path.join(stage, "resolve");
  try {
    privateFolder(work);
    privateFolder(project);
    const manifestText = npmManifestText(ref);
    fs.writeFileSync(path.join(project, "package.json"), manifestText, { mode: 0o600 });
    const env = npmEnvironment({ work, node, cacheDir, environment });
    await npm(
      [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--save-exact",
        `--registry=${registry}`,
      ],
      { cwd: project, node, env, execute, log, signal },
    );
    return {
      manifestText,
      lockText: fs.readFileSync(path.join(project, "package-lock.json"), "utf8"),
    };
  } catch (error) {
    throw wrapped(error);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
}

/** Installs a checked lockfile with `npm ci`; scripts run only when allowed. */
export async function installNpm({
  directory,
  manifestText,
  lockText,
  ref,
  node,
  registry,
  cacheDir,
  allowScripts,
  execute = runProcessTree,
  environment = process.env,
  log,
  signal,
}) {
  const work = path.join(directory, ".npm-work");
  try {
    privateFolder(directory);
    fs.writeFileSync(path.join(directory, "package.json"), manifestText, { mode: 0o600 });
    fs.writeFileSync(path.join(directory, "package-lock.json"), lockText, {
      mode: 0o600,
    });
    privateFolder(work);
    const env = npmEnvironment({ work, node, cacheDir, environment });
    await npm(
      [
        "ci",
        "--include=optional",
        `--registry=${registry}`,
        ...(allowScripts === true ? [] : ["--ignore-scripts"]),
      ],
      { cwd: directory, node, env, execute, log, signal },
    );
    const installed = readJSON(
      path.join(directory, "node_modules", ...ref.name.split("/"), "package.json"),
      {},
    );
    if (installed?.name !== ref.name || installed?.version !== ref.version)
      throw failed();
  } catch (error) {
    throw wrapped(error);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
