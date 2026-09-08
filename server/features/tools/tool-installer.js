import {
  nativeInstallers,
  nativeDestination,
  installNative,
} from "./native-installer.js";
import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import {
  cleanEnvironment,
  detectTools,
  detectUtilities,
} from "../accounts/account-store.js";
import { prepareGithubCli } from "./github-cli-installer.js";
import { toolBinDirectories } from "./tool-paths.js";
import { problem, readJSON, writePrivate } from "../../lib/storage.js";
const catalog = {
  codex: {
    name: "Codex",
    packageName: "@openai/codex",
    documentation: "https://learn.chatgpt.com/docs/codex/cli",
  },
  claude: {
    name: "Claude Code",
    packageName: "@anthropic-ai/claude-code",
    documentation: "https://code.claude.com/docs/en/setup",
  },
  opencode: {
    name: "OpenCode",
    packageName: "opencode-ai",
    documentation: "https://opencode.ai/docs/",
  },
  gh: {
    name: "GitHub CLI",
    packageName: "cli/cli",
    installer: "github-release",
    utility: true,
    documentation: "https://cli.github.com/manual/",
  },
};
function npmPath() {
  for (const dir of [
    path.dirname(process.execPath),
    ...(process.env.PATH || "").split(path.delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]) {
    try {
      const file = fs.realpathSync(path.join(dir, "npm"));
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}
function groupSignal(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {}
}
function run(command, args, env, cwd, signal, timeout) {
  return new Promise((resolve, reject) => {
    if (signal.aborted)
      return reject(problem(serverMessages.tools.installationAborted, 409));
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "",
      reason = null,
      killTimer;
    const capture = (data) => {
      output = (output + data).slice(-16384);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const stop = (message) => {
      if (reason) return;
      reason = message;
      groupSignal(child, "SIGTERM");
      killTimer = setTimeout(() => groupSignal(child, "SIGKILL"), 500);
    };
    const abort = () => stop(serverMessages.tools.installationShutdown);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => stop(serverMessages.tools.installationTimeout),
      timeout,
    );
    const finish = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      groupSignal(child, "SIGKILL");
    };
    child.on("error", () => {
      finish();
      reject(problem(serverMessages.tools.installerUnavailable, 409));
    });
    child.on("close", (code) => {
      finish();
      if (reason) return reject(problem(reason, 409));
      if (code !== 0) {
        const hint = output.match(
          /\b(EACCES|ENOSPC|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|EBADENGINE)\b/,
        )?.[1];
        return reject(
          problem(serverMessages.tools.installationExitFailure(code, hint), 409),
        );
      }
      resolve(output);
    });
  });
}
function safeDirectory(directory) {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw problem(serverMessages.tools.installationDirectoryInvalid, 409);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    fs.mkdirSync(directory, { mode: 0o700 });
  }
}
export class ToolInstaller {
  constructor({
    dataDir,
    home,
    npmCli = npmPath(),
    detect,
    timeout = 15 * 60 * 1000,
    platform = process.platform,
    arch = process.arch,
    githubFetch = fetch,
    nativeFetch = fetch,
  }) {
    this.dataDir = dataDir;
    this.home = home;
    this.root = path.join(dataDir, "clis");
    this.file = path.join(dataDir, "tool-installations.json");
    this.npmCli = npmCli;
    this.timeout = timeout;
    this.platform = platform;
    this.arch = arch;
    this.githubFetch = githubFetch;
    this.nativeFetch = nativeFetch;
    this.detect =
      detect ||
      (() => [
        ...detectTools({ ...process.env, HOME: home }, true, toolBinDirectories(dataDir)),
        ...detectUtilities(
          { ...process.env, HOME: home },
          true,
          toolBinDirectories(dataDir),
        ),
      ]);
    this.platformReason =
      !["darwin", "linux"].includes(platform) || !["arm64", "x64"].includes(arch)
        ? serverMessages.tools.directInstallPlatformNotice
        : null;
    this.reason =
      this.platformReason || (!npmCli ? serverMessages.tools.npmUnavailable : null);
    this.records = readJSON(this.file, {});
    this.active = null;
    this.closed = false;
    for (const job of Object.values(this.records))
      if (job.status === "running") {
        job.status = "failed";
        job.message = serverMessages.tools.installationInterrupted;
        job.finishedAt = new Date().toISOString();
      }
  }
  list() {
    const found = this.detect();
    return {
      busy: !!this.active,
      installations: Object.entries(catalog).map(([tool, meta]) => ({
        tool,
        ...meta,
        ...(nativeInstallers[tool]
          ? { installer: "native-script", installerUrl: nativeInstallers[tool].url }
          : {}),
        status: "idle",
        version: null,
        startedAt: null,
        finishedAt: null,
        message: "",
        ...this.records[tool],
        installer:
          nativeInstallers[tool] && this.records[tool]?.method !== "npm"
            ? "native-script"
            : meta.installer || "npm",
        available: !this.platformReason,
        reason: this.platformReason,
        destination:
          nativeInstallers[tool] && this.records[tool]?.method !== "npm"
            ? nativeDestination(this.home, tool)
            : path.join(this.root, tool),
        installed: !!found.find((x) => x.id === tool)?.installed,
      })),
    };
  }
  start(tool, method = "native") {
    if (typeof tool !== "string" || !Object.hasOwn(catalog, tool))
      throw problem(serverMessages.common.unknownCliTool);
    if (this.closed) throw problem(serverMessages.tools.serviceStopping, 503);
    if (!["native", "npm"].includes(method) || (tool === "gh" && method !== "native"))
      throw problem("Invalid installer method.");
    const reason = method === "npm" ? this.reason : this.platformReason;
    if (reason) throw problem(reason, 409);
    if (this.active) throw problem(serverMessages.tools.installationAlreadyRunning, 409);
    if (this.detect().find((x) => x.id === tool)?.installed)
      throw problem(serverMessages.tools.alreadyInstalled, 409);
    safeDirectory(this.root);
    const destination =
      method === "native" && nativeInstallers[tool]
        ? path.join(nativeDestination(this.home, tool), tool)
        : path.join(this.root, tool);
    try {
      fs.lstatSync(destination);
      throw problem(serverMessages.tools.installationDirectoryExists, 409);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const controller = new AbortController();
    const job = {
      tool,
      method,
      status: "running",
      version: null,
      message: serverMessages.tools.installingPackage,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.records[tool] = job;
    writePrivate(this.file, this.records);
    const active = { controller, done: null };
    this.active = active;
    active.done = this.install(tool, job, controller.signal)
      .catch(() => {
        job.message += serverMessages.tools.statusSaveFailureSuffix;
      })
      .finally(() => {
        if (this.active === active) this.active = null;
      });
    return this.list().installations.find((x) => x.tool === tool);
  }
  async install(tool, job, signal) {
    let work,
      versionDirectory,
      published = false,
      releaseVersion,
      finalStatus = "failed";
    try {
      work = await fsp.mkdtemp(path.join(this.root, ".install-"));
      const prefix = path.join(work, "prefix");
      const env = {
        ...cleanEnvironment(),
        HOME: tool === "gh" ? work : this.home,
        PATH: [path.dirname(process.execPath), process.env.PATH || ""].join(
          path.delimiter,
        ),
        DISABLE_AUTOUPDATER: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
      };
      if (job.method === "native" && nativeInstallers[tool]) {
        job.version = await installNative({
          tool,
          home: this.home,
          work,
          env,
          signal,
          timeout: this.timeout,
          fetchImpl: this.nativeFetch,
          run,
        });
        finalStatus = "succeeded";
        job.message = serverMessages.tools.cliInstalled;
        return;
      }
      if (tool === "gh") {
        env.GH_CONFIG_DIR = path.join(work, "gh-config");
        env.GH_NO_UPDATE_NOTIFIER = "1";
        env.GH_PROMPT_DISABLED = "1";
        job.message = serverMessages.tools.downloadingVerifiedRelease;
        writePrivate(this.file, this.records);
        releaseVersion = (
          await prepareGithubCli({
            prefix,
            platform: this.platform,
            arch: this.arch,
            fetchImpl: this.githubFetch,
            signal,
            timeout: this.timeout,
          })
        ).version;
      } else {
        const config = path.join(work, "npmrc"),
          globalConfig = path.join(work, "global-npmrc");
        await fsp.writeFile(config, "", { mode: 0o600 });
        await fsp.writeFile(globalConfig, "", { mode: 0o600 });
        Object.assign(env, {
          NPM_CONFIG_USERCONFIG: config,
          NPM_CONFIG_GLOBALCONFIG: globalConfig,
          NPM_CONFIG_CACHE: path.join(work, "cache"),
          NPM_CONFIG_UPDATE_NOTIFIER: "false",
        });
        // Fixed packages, public registry, empty npm config and a private prefix. No shell or sudo.
        await run(
          process.execPath,
          [
            this.npmCli,
            "install",
            "--global",
            "--prefix",
            prefix,
            "--include=optional",
            "--ignore-scripts=false",
            "--registry=https://registry.npmjs.org",
            "--userconfig",
            config,
            "--globalconfig",
            globalConfig,
            "--cache",
            path.join(work, "cache"),
            "--no-audit",
            "--no-fund",
            "--loglevel=error",
            catalog[tool].packageName + "@latest",
          ],
          env,
          work,
          signal,
          this.timeout,
        );
      }
      job.message = serverMessages.tools.checkingInstalledVersion;
      writePrivate(this.file, this.records);
      const verify = async (root) => {
        const binary = path.join(root, "bin", tool);
        let real;
        try {
          real = await fsp.realpath(binary);
          if (!real.startsWith((await fsp.realpath(root)) + path.sep)) throw Error();
          await fsp.access(binary, fs.constants.X_OK);
        } catch {
          throw problem(serverMessages.tools.installedCliNotExecutable, 409);
        }
        const output = stripVTControlCharacters(
          await run(binary, ["--version"], env, work, signal, 15000),
        ).trim();
        if (!/\b\d+\.\d+(?:\.\d+)?\b/.test(output) || output.length > 512)
          throw problem(serverMessages.tools.installedVersionCheckFailed, 409);
        if (
          tool === "gh" &&
          output.match(/^gh version (\d+\.\d+\.\d+)(?:\s|$)/)?.[1] !== releaseVersion
        )
          throw problem(serverMessages.tools.installedReleaseVersionMismatch, 409);
        return output.split("\n")[0].slice(0, 160);
      };
      await verify(prefix);
      const packages = path.join(this.root, ".packages");
      safeDirectory(packages);
      versionDirectory = path.join(packages, randomUUID());
      await fsp.rename(prefix, versionDirectory);
      job.version = await verify(versionDirectory);
      if (signal.aborted) throw problem(serverMessages.tools.installationAborted, 409);
      if (this.detect().find((x) => x.id === tool)?.installed)
        throw problem(serverMessages.tools.cliInstalledElsewhere, 409);
      // Creating the activation link is atomic and fails if anybody created this path meanwhile.
      await fsp.symlink(
        path.relative(this.root, versionDirectory),
        path.join(this.root, tool),
        "dir",
      );
      published = true;
      finalStatus = "succeeded";
      job.message =
        tool === "gh"
          ? serverMessages.tools.githubCliInstalled
          : serverMessages.tools.cliInstalled;
    } catch (error) {
      finalStatus = "failed";
      job.version = null;
      job.message = error.status
        ? error.message
        : serverMessages.tools.installationTargetFailed;
    } finally {
      if (!published && versionDirectory)
        await fsp.rm(versionDirectory, { recursive: true, force: true }).catch(() => {});
      if (work) await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
      job.status = finalStatus;
      job.finishedAt = new Date().toISOString();
      writePrivate(this.file, this.records);
    }
  }
  async close() {
    this.closed = true;
    if (this.active) {
      this.active.controller.abort();
      await this.active.done;
    }
  }
}
