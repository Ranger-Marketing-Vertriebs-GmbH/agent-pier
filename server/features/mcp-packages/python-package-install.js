import fs from "node:fs";
import path from "node:path";
import { proxyEnvironment } from "../../lib/proxy-environment.js";
import { runProcessTree } from "./child-process-tree.js";
import { packageError, packageProblem } from "./package-errors.js";
import { uvCertificateFile } from "./uv-certificates.js";
import { privateFolder } from "./verified-files.js";

const failed = () => packageProblem("MCP_PACKAGE_INSTALL_FAILED", 502);
/** Any failure becomes the stable install code: uv output and errors carry paths. */
const wrapped = (error) => packageError(error, "MCP_PACKAGE_INSTALL_FAILED", 502);
// uv 0.12.21 (preflight B4): "<pkg> has no usable wheels" plus the hint "Wheels are
// required for". uv wraps the first message at its terminal width.
const noWheel = /has\s+no\s+usable\s+wheels|Wheels\s+are\s+required\s+for/;
// uv's resolver report when no set of versions satisfies the requirements; without a
// terminal uv 0.12.21 writes "error: No solution found when resolving dependencies".
const noSolution = /No\s+solution\s+found\s+when\s+resolving/;
// Inside that report: a release (top or dependency) excludes the managed Python.
const pythonMismatch =
  /requires\s+Python\b|Python\s+version\s+\([^)]*\)\s+does\s+not\s+satisfy/;
/**
 * What a failed `uv pip compile` means: "build" (a missing wheel wins, it needs a
 * build), "python" (a release excludes the managed Python), "unsatisfiable" (no set of
 * versions fits) or "failed" (anything else, such as a network error).
 */
export function compileFailure(output) {
  if (noWheel.test(output)) return "build";
  if (!noSolution.test(output)) return "failed";
  return pythonMismatch.test(output) ? "python" : "unsatisfiable";
}
const refusals = {
  python: () => packageProblem("MCP_PACKAGE_UNSATISFIABLE", 400, "pythonUnsupported"),
  unsatisfiable: () => packageProblem("MCP_PACKAGE_UNSATISFIABLE", 400),
};
/** The stable refusal for a failed compile; uv's report stays in the log. */
const refusal = (output) => (refusals[compileFailure(output)] ?? failed)();
// `--no-build` means the same, but uv refuses it next to `--only-binary`.
const wheelsOnly = ["--only-binary", ":all:"];

/**
 * Only proxy variables and the owner's CA (as SSL_CERT_FILE, a bundle in `work`)
 * are passed on; uv reads no config file (uv.toml, pip.conf variables, pyproject)
 * and downloads no Python. UV_NATIVE_TLS stays unset: the operating system's store
 * is not what Node trusts. Source builds (opt-in) use the system `cc`: CPython's
 * sysconfig names `clang`, which a Linux host often lacks (preflight B12).
 */
export function uvEnvironment({ work, index, cacheDir, environment, allowScripts }) {
  for (const name of ["home", "tmp"]) privateFolder(path.join(work, name));
  const certificates = uvCertificateFile(work, environment ?? process.env);
  return {
    ...proxyEnvironment(environment),
    HOME: path.join(work, "home"),
    TMPDIR: path.join(work, "tmp"),
    PATH: ["/usr/bin", "/bin"].join(path.delimiter),
    NO_COLOR: "1",
    UV_NO_CONFIG: "1",
    UV_INDEX_URL: index,
    UV_PYTHON_DOWNLOADS: "never",
    UV_LINK_MODE: "copy",
    UV_CACHE_DIR: privateFolder(cacheDir),
    // Node's roots plus the owner's CA, as one file: see uv-certificates.js.
    ...(certificates ? { SSL_CERT_FILE: certificates } : {}),
    ...(allowScripts === true ? { CC: "cc", CXX: "c++" } : {}),
  };
}

/** Runs uv; its raw output goes only to `log` (the job log redacts it). */
async function uv(python, args, { cwd, env, execute, log, signal }) {
  try {
    const { stdout, stderr } = await execute(python.uvPath, args, {
      cwd,
      env,
      timeout: 600000,
      maxBuffer: 4 * 1024 * 1024,
      signal,
    });
    log?.(`${stdout}\n${stderr}`);
    return { ok: true, output: "" };
  } catch (error) {
    const output = `${error.stdout || ""}\n${error.stderr || ""}`;
    log?.(output);
    if (signal?.aborted) throw packageProblem("MCP_PACKAGE_CANCELLED", 409);
    return { ok: false, output };
  }
}

/**
 * Resolves `name==version` to a hashed lock, narrowed by the owner's checked
 * `constraints` (D4); builds nothing without the opt-in.
 */
export async function resolvePython({
  stage,
  ref,
  python,
  index,
  cacheDir,
  allowScripts,
  constraints = [],
  execute = runProcessTree,
  environment = process.env,
  log,
  signal,
}) {
  const work = path.join(stage, ".uv-work");
  try {
    privateFolder(work);
    const env = uvEnvironment({ work, index, cacheDir, environment, allowScripts });
    const requirementsText = `${ref.name}==${ref.version}\n`;
    const input = path.join(work, "requirements.in");
    const output = path.join(work, "requirements.lock");
    fs.writeFileSync(input, requirementsText, { mode: 0o600 });
    const constraintArgs = [];
    if (constraints.length) {
      const file = path.join(work, "constraints.txt");
      fs.writeFileSync(file, `${constraints.join("\n")}\n`, { mode: 0o600 });
      constraintArgs.push("-c", file);
    }
    // No header and no annotations: both name the input and constraints files by
    // their stage paths (preflight B2).
    const compile = (extra) =>
      uv(
        python,
        [
          "pip",
          "compile",
          input,
          "--generate-hashes",
          "--no-header",
          "--no-annotate",
          "--python",
          python.pythonPath,
          "-o",
          output,
          ...constraintArgs,
          ...extra,
        ],
        { cwd: work, env, execute, log, signal },
      );
    const trial = await compile(wheelsOnly);
    let needsScripts = false;
    if (!trial.ok) {
      if (compileFailure(trial.output) !== "build") throw refusal(trial.output);
      needsScripts = true;
      if (allowScripts !== true)
        return { requirementsText, lockText: null, needsScripts };
      const built = await compile([]);
      if (!built.ok) throw refusal(built.output);
    }
    return { requirementsText, lockText: fs.readFileSync(output, "utf8"), needsScripts };
  } catch (error) {
    throw wrapped(error);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Installs a checked lock into `<directory>/venv`; sdists build only with the opt-in. */
export async function installPython({
  directory,
  requirementsText,
  lockText,
  python,
  index,
  cacheDir,
  allowScripts,
  execute = runProcessTree,
  environment = process.env,
  log,
  signal,
}) {
  const work = path.join(directory, ".uv-work");
  try {
    privateFolder(directory);
    const lock = path.join(directory, "requirements.lock");
    fs.writeFileSync(path.join(directory, "requirements.in"), requirementsText, {
      mode: 0o600,
    });
    fs.writeFileSync(lock, lockText, { mode: 0o600 });
    privateFolder(work);
    const env = uvEnvironment({ work, index, cacheDir, environment, allowScripts });
    const venv = path.join(directory, "venv");
    const options = { cwd: work, env, execute, log, signal };
    const created = await uv(
      python,
      ["venv", "--relocatable", "--python", python.pythonPath, venv],
      options,
    );
    if (!created.ok) throw failed();
    const synced = await uv(
      python,
      [
        "pip",
        "sync",
        lock,
        "--require-hashes",
        "--python",
        path.join(venv, "bin", "python"),
        ...(allowScripts === true ? [] : wheelsOnly),
      ],
      options,
    );
    if (!synced.ok) throw failed();
  } catch (error) {
    throw wrapped(error);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
