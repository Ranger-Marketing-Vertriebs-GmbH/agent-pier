import {
  nativeInstallers,
  nativeDestination,
  installNative,
} from "./native-installer.js";
import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
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
import { planToolUpdate, updateCommands, updateTool } from "./tool-update.js";
import { run } from "./tool-run.js";
export { run };
import {
  chromiumUnavailable,
  installChromium,
  managedChromium,
  removeChromium,
  sweepChromium,
} from "./chromium-installer.js";
import { chromiumManifest } from "./chromium-manifest.js";
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
  nono: {
    name: "nono",
    utility: true,
    documentation: "https://nono.sh/docs/cli/getting_started/installation",
  },
  // The agents' browser: a pinned Chrome for Testing build (chromium-installer.js).
  chromium: {
    name: "Chrome for Testing",
    packageName: `Chrome for Testing ${chromiumManifest.version}`,
    installer: "chrome-for-testing",
    utility: true,
    documentation: "https://developer.chrome.com/blog/chrome-for-testing",
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
    chromiumFetch = fetch,
    manifest = chromiumManifest,
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
    this.chromiumFetch = chromiumFetch;
    this.manifest = manifest;
    this.chromiumReason = chromiumUnavailable(platform, arch, manifest);
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
        ...this.updateAvailability(
          tool,
          found.find((x) => x.id === tool),
        ),
        ...(tool === "chromium" ? this.chromiumState() : {}),
      })),
    };
  }
  /** The managed browser's row: installed version, pinned version, update, removal. */
  chromiumState() {
    const installed = managedChromium(this.root);
    const reason = this.platformReason || this.chromiumReason;
    const current = installed?.version === this.manifest.version;
    return {
      available: !reason,
      reason,
      destination: path.join(this.root, "chromium"),
      installed: !!installed,
      installedVersion: installed?.version || null,
      pinnedVersion: this.manifest.version,
      updateCommand: `Chrome for Testing ${this.manifest.version}`,
      updateAvailable: !!installed && !current && !reason,
      updateReason: installed && current ? serverMessages.tools.chromiumUpToDate : reason,
      removable: !!installed,
    };
  }
  /**
   * The update path: an AgentPier update can pin a newer browser; an installed
   * managed browser follows it in the background at the next server start.
   */
  /** Sweeps an interrupted install's leftovers; only while no job runs. */
  sweepChromium() {
    if (this.active) return;
    try {
      sweepChromium(this.root);
    } catch {
      /* Retried at the next start. */
    }
  }
  keepChromiumCurrent() {
    try {
      if (this.chromiumState().updateAvailable) return this.startUpdate("chromium");
    } catch {
      /* Busy or unavailable: the tools list still offers the update. */
    }
    return null;
  }
  /** Removes the managed browser; only it can be removed here. */
  async remove(tool) {
    if (tool !== "chromium") throw problem(serverMessages.common.unknownCliTool);
    if (this.closed) throw problem(serverMessages.tools.serviceStopping, 503);
    if (this.active) throw problem(serverMessages.tools.installationAlreadyRunning, 409);
    // Wired by services.js: an agent browser runs, or the Gateway compiled this path.
    if (this.chromiumInUse?.()) throw problem(serverMessages.tools.chromiumInUse, 409);
    await removeChromium(this.root);
    this.records[tool] = {
      tool,
      status: "idle",
      version: null,
      message: serverMessages.tools.chromiumRemoved,
      startedAt: null,
      finishedAt: new Date().toISOString(),
    };
    writePrivate(this.file, this.records);
    return this.list().installations.find((x) => x.tool === tool);
  }
  updateAvailability(tool, detected) {
    if (!Object.hasOwn(updateCommands, tool)) return {};
    const updateCommand = updateCommands[tool]
      ? [tool, ...updateCommands[tool]].join(" ")
      : nativeInstallers[tool].url;
    try {
      const plan = planToolUpdate(tool, this.home, this.root, detected);
      return {
        updateCommand,
        updateAvailable: !this.platformReason,
        migrate: plan.migrate,
        updateReason: this.platformReason,
      };
    } catch {
      return {
        updateCommand,
        updateAvailable: false,
        updateReason: serverMessages.tools.nativeUpdateRequired,
      };
    }
  }
  startUpdate(tool) {
    if (this.closed) throw problem(serverMessages.tools.serviceStopping, 503);
    if (this.platformReason) throw problem(this.platformReason, 409);
    if (this.active) throw problem(serverMessages.tools.installationAlreadyRunning, 409);
    if (tool === "chromium") {
      const state = this.chromiumState();
      if (!state.installed) throw problem(serverMessages.tools.chromiumNotInstalled, 409);
      if (!state.updateAvailable) throw problem(state.updateReason, 409);
      safeDirectory(this.root);
      return this.schedule(tool, "native", { chromium: true });
    }
    const plan = planToolUpdate(
      tool,
      this.home,
      this.root,
      this.detect().find((item) => item.id === tool),
    );
    safeDirectory(this.root);
    return this.schedule(tool, "native", plan);
  }
  start(tool, method = "native") {
    if (typeof tool !== "string" || !Object.hasOwn(catalog, tool))
      throw problem(serverMessages.common.unknownCliTool);
    if (this.closed) throw problem(serverMessages.tools.serviceStopping, 503);
    if (
      !["native", "npm"].includes(method) ||
      (["gh", "nono"].includes(tool) && method !== "native")
    )
      throw problem(serverMessages.tools.invalidInstallerMethod);
    const reason =
      method === "npm"
        ? this.reason
        : tool === "chromium"
          ? this.platformReason || this.chromiumReason
          : this.platformReason;
    if (reason) throw problem(reason, 409);
    if (this.active) throw problem(serverMessages.tools.installationAlreadyRunning, 409);
    if (tool === "chromium") {
      if (method !== "native") throw problem(serverMessages.tools.invalidInstallerMethod);
      if (managedChromium(this.root))
        throw problem(serverMessages.tools.alreadyInstalled, 409);
      safeDirectory(this.root);
      return this.schedule(tool, method);
    }
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
    return this.schedule(tool, method);
  }
  schedule(tool, method, updatePlan) {
    const controller = new AbortController();
    const job = {
      tool,
      method,
      operation: updatePlan ? "update" : "install",
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
    active.done = this.install(tool, job, controller.signal, updatePlan)
      .catch(() => {
        job.message += serverMessages.tools.statusSaveFailureSuffix;
      })
      .finally(() => {
        if (this.active === active) this.active = null;
      });
    return this.list().installations.find((x) => x.tool === tool);
  }
  async install(tool, job, signal, updatePlan) {
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
      if (tool === "chromium") {
        const result = await installChromium({
          root: this.root,
          platform: this.platform,
          arch: this.arch,
          manifest: this.manifest,
          fetchImpl: this.chromiumFetch,
          signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeout)]),
          run,
          env,
          progress: (message) => {
            job.message = message;
            writePrivate(this.file, this.records);
          },
        });
        job.version = `Chrome for Testing ${result.version}`;
        finalStatus = "succeeded";
        job.message = updatePlan
          ? serverMessages.tools.chromiumUpdated
          : serverMessages.tools.chromiumInstalled;
        return;
      }
      if (updatePlan) {
        job.version = await updateTool({
          tool,
          plan: updatePlan,
          home: this.home,
          root: this.root,
          work,
          env,
          signal,
          timeout: this.timeout,
          fetchImpl: this.nativeFetch,
          run,
        });
        finalStatus = "succeeded";
        job.message = serverMessages.tools.cliUpdated;
        return;
      }
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
