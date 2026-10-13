import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { folder, atomic, readJson, digest, identifier, readFile } from "./files.js";
import {
  releaseVersion,
  releaseManifest,
  unpackRelease,
  smokeRelease,
  RELEASE_LIMIT,
} from "./release-archive.js";
import { applicationVersion, compareReleaseVersions } from "./version.js";
import { problem } from "../../lib/storage.js";
import { requireDataCompatibility } from "./release-schema.js";

import { cleanupState, cleanupReleases, releaseProcesses } from "./release-cleanup.js";
import { officialChannel, ReleaseNotes } from "./release-notes.js";
import { download } from "./release-download.js";
import {
  isOfficialChannel,
  publicChannel,
  offeredVersion,
  channelManifest,
  previewManifest,
} from "./release-channel.js";

export {
  download,
  downloadRetryDelay,
  DOWNLOAD_IDLE_TIMEOUT,
} from "./release-download.js";
export class Releases {
  constructor({
    dataDir,
    installRoot = process.env.AGENTPIER_INSTALL_ROOT,
    channel = process.env.AGENTPIER_RELEASE_CHANNEL,
    fetchImpl = fetch,
    smoke = smokeRelease,
    port = 4380,
    spawnImpl = spawn,
    environment = process.env,
    processes = releaseProcesses,
  }) {
    this.dataDir = fs.realpathSync(dataDir);
    this.installRoot = installRoot ? path.resolve(installRoot) : null;
    this.channel = !channel || isOfficialChannel(channel) ? officialChannel : channel;
    this.channelRevision = 0;
    this.fetchImpl = fetchImpl;
    this.releaseNotes = new ReleaseNotes((...args) => this.fetchImpl(...args));
    this.smoke = smoke;
    this.port = port;
    this.spawn = spawnImpl;
    this.environment = environment;
    this.processes = processes;
    this.directory = folder(path.join(this.dataDir, "operations/releases"));
  }
  // Returns null when the preference file cannot be read as JSON.
  storedUpdateChannel() {
    try {
      return readJson(path.join(this.dataDir, "operations/release-preferences.json"), {})
        ?.updateChannel === "preview"
        ? "preview"
        : "stable";
    } catch {
      return null;
    }
  }
  get updateChannel() {
    // A damaged preference file falls back to Stable; saving a channel repairs it.
    return this.storedUpdateChannel() ?? "stable";
  }
  setUpdateChannel(value) {
    if (!["stable", "preview"].includes(value))
      throw problem(serverMessages.operations.invalidOptions);
    if (!isOfficialChannel(this.channel))
      throw problem(serverMessages.releases.channelManaged, 409);
    // A repeated selection must not abort a check or download that is still running.
    if (this.storedUpdateChannel() === value) return this.status();
    atomic(path.join(this.dataDir, "operations/release-preferences.json"), {
      updateChannel: value,
    });
    this.channelRevision += 1;
    fs.rmSync(path.join(this.directory, "candidate.json"), { force: true });
    return this.status();
  }
  status() {
    const root = this.installRoot;
    const installed = Boolean(root && fs.existsSync(path.join(root, "current")));
    const current = installed
      ? readJson(path.join(root, "current/release.json"))?.version
      : applicationVersion();
    const releases =
      root && fs.existsSync(path.join(root, "releases"))
        ? fs
            .readdirSync(path.join(root, "releases"))
            .filter((name) => /^\d+\.\d+\.\d+/.test(name))
            .map((version) => {
              let canRollback = version !== current,
                reason;
              try {
                const manifest = releaseManifest(
                  readJson(
                    path.join(root, "releases", releaseVersion(version), "release.json"),
                  ),
                );
                requireDataCompatibility(manifest, this.dataDir);
              } catch {
                canRollback = false;
                reason = serverMessages.releases.incompatibleRollback;
              }
              return {
                version,
                current: version === current,
                canRollback,
                ...(reason ? { reason } : {}),
              };
            })
        : [];
    const staged = fs
      .readdirSync(this.directory)
      .filter((name) => /^[a-f0-9-]+\.json$/.test(name))
      .map((name) => readJson(path.join(this.directory, name)))
      .map(({ id, version }) => ({ id, version }));
    return {
      current,
      installed,
      supported: ["darwin", "linux"].includes(process.platform) && Boolean(root),
      ...(!installed
        ? {
            reason: serverMessages.releases.versionedInstallMissing,
          }
        : {}),
      releases,
      staged,
      channel: publicChannel(this.channel),
      updateChannel: this.updateChannel,
      updateChannelManaged: !isOfficialChannel(this.channel),
    };
  }
  cleanupStatus() {
    return cleanupState(this);
  }
  cleanup(versions) {
    return cleanupReleases(this, versions);
  }
  stagedVersion(stagedId) {
    const receipt = readJson(
      path.join(this.directory, `${identifier(stagedId)}.json`),
      null,
    );
    if (!receipt) throw problem(serverMessages.releases.stagedNotFound, 404);
    return releaseVersion(receipt.version);
  }
  notes(version) {
    return this.releaseNotes.read(this.channel, version);
  }
  notesRange(from, to) {
    return this.releaseNotes.range(this.channel, from, to);
  }
  async check() {
    if (!this.channel) throw problem(serverMessages.releases.channelRequired, 409);
    const base = new URL(this.channel.endsWith("/") ? this.channel : `${this.channel}/`);
    if (base.protocol !== "https:" || base.username || base.password)
      throw problem(serverMessages.releases.channelHttpsRequired);
    const updateChannel = this.updateChannel;
    const channelRevision = this.channelRevision;
    const official = isOfficialChannel(this.channel);
    const manifest =
      official && updateChannel === "preview"
        ? await previewManifest(this.fetchImpl)
        : await channelManifest(base, this.fetchImpl);
    if (channelRevision !== this.channelRevision || updateChannel !== this.updateChannel)
      throw problem(serverMessages.releases.channelChanged, 409);
    if (official && !offeredVersion(manifest.version, updateChannel))
      throw problem(serverMessages.releases.channelManifestInvalid);
    releaseVersion(manifest.version);
    const platform = `${process.platform}-${process.arch}`,
      artifact = manifest.artifacts?.[platform];
    if (
      !artifact ||
      !/^[A-Za-z0-9._-]+\.aprelease$/.test(artifact.file) ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      manifest.schemaVersion !== 1
    )
      throw problem(serverMessages.releases.artifactIncompatible, 409);
    const current = this.status().current;
    const plan = {
      current,
      updateChannel,
      version: manifest.version,
      upToDate: compareReleaseVersions(current, manifest.version) >= 0,
      platform,
      sha256: artifact.sha256,
      ...(artifact.bytes ? { bytes: artifact.bytes } : {}),
      schemaVersion: 1,
      file: artifact.file,
    };
    atomic(path.join(this.directory, "candidate.json"), plan);
    return plan;
  }
  async stage({ version, archive } = {}) {
    if (!this.installRoot)
      throw problem(serverMessages.releases.installRootRequired, 409);
    if (
      this.dataDir === this.installRoot ||
      this.dataDir.startsWith(`${this.installRoot}/releases/`) ||
      this.dataDir.startsWith(`${this.installRoot}/current/`)
    )
      throw problem(serverMessages.releases.dataInsideReleases, 409);
    const channelRevision = this.channelRevision;
    let bytes, plan;
    if (archive) bytes = readFile(archive, RELEASE_LIMIT);
    else {
      const reviewed = readJson(path.join(this.directory, "candidate.json"), null);
      plan = await this.check();
      if (plan.upToDate) throw problem(serverMessages.releases.noNewerVersion, 409);
      if (
        plan.version !== version ||
        (reviewed &&
          (reviewed.version !== plan.version || reviewed.sha256 !== plan.sha256))
      )
        throw problem(serverMessages.releases.channelChanged, 409);
      const base = this.channel.endsWith("/") ? this.channel : `${this.channel}/`;
      const artifactBase =
        base === officialChannel
          ? new URL(`../../download/v${plan.version}/`, base).href
          : base;
      bytes = await download(
        new URL(plan.file, artifactBase).href,
        this.fetchImpl,
        RELEASE_LIMIT,
      );
      if (channelRevision !== this.channelRevision)
        throw problem(serverMessages.releases.channelChanged, 409);
      if (digest(bytes) !== plan.sha256)
        throw problem(serverMessages.releases.checksumMismatch);
    }
    const root = folder(this.installRoot),
      stage = folder(path.join(root, `.staging-${randomUUID()}`));
    try {
      const manifest = unpackRelease(bytes, stage);
      requireDataCompatibility(manifest, this.dataDir);
      if (version && manifest.version !== version)
        throw problem(serverMessages.releases.versionMismatch);
      await this.smoke(stage);
      if (!archive && channelRevision !== this.channelRevision)
        throw problem(serverMessages.releases.channelChanged, 409);
      const destination = path.join(
        folder(path.join(root, "releases")),
        manifest.version,
      );
      if (fs.existsSync(destination))
        throw problem(serverMessages.releases.alreadyExists, 409);
      fs.renameSync(stage, destination);
      const id = randomUUID();
      atomic(path.join(this.directory, `${id}.json`), {
        id,
        version: manifest.version,
        sha256: digest(bytes),
        createdAt: new Date().toISOString(),
      });
      return { stagedId: id, version: manifest.version };
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  launchActivation(input, jobId) {
    if (!this.installRoot)
      throw problem(serverMessages.releases.versionedInstallRequired, 409);
    if (input.stagedId) identifier(input.stagedId);
    else releaseVersion(input.version);
    const request = path.join(this.directory, `activation-${identifier(jobId)}.json`);
    atomic(request, {
      ...input,
      jobId,
      installRoot: this.installRoot,
      dataDir: this.dataDir,
      port: this.port,
    });
    const helper = fileURLToPath(new URL("./release-helper.js", import.meta.url));
    const child = this.spawn(process.execPath, [helper, request], {
      detached: true,
      stdio: "ignore",
      env: Object.fromEntries(
        [
          "PATH",
          "HOME",
          "USER",
          "XDG_RUNTIME_DIR",
          "DBUS_SESSION_BUS_ADDRESS",
          "XDG_CONFIG_HOME",
        ]
          .filter((key) => typeof this.environment[key] === "string")
          .map((key) => [key, this.environment[key]]),
      ),
    });
    child.unref();
    return new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }
}
