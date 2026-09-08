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
import { applicationVersion } from "./version.js";
import { problem } from "../../lib/storage.js";
import { requireDataCompatibility } from "./release-schema.js";

export async function download(url, fetchImpl, limit) {
  let response;
  for (let redirect = 0; redirect <= 5; redirect++) {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password)
      throw problem("Release downloads require HTTPS without embedded credentials.");
    response = await fetchImpl(target.href, {
      signal: AbortSignal.timeout(120000),
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (redirect === 5 || !response.headers.get("location"))
      throw problem("Release redirect limit exceeded.");
    url = new URL(response.headers.get("location"), target).href;
    await response.body?.cancel();
  }
  if (!response.ok) throw problem("Release download failed.", 502);
  if (Number(response.headers.get("content-length")) > limit)
    throw problem("Release download exceeds its limit.", 413);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) throw problem("Release download exceeds its limit.", 413);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
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
  }) {
    this.dataDir = fs.realpathSync(dataDir);
    this.installRoot = installRoot ? path.resolve(installRoot) : null;
    this.channel = channel || null;
    this.fetchImpl = fetchImpl;
    this.smoke = smoke;
    this.port = port;
    this.spawn = spawnImpl;
    this.environment = environment;
    this.directory = folder(path.join(this.dataDir, "operations/releases"));
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
                reason = "Release platform or schema is incompatible.";
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
            reason:
              "Create a versioned installation with the release CLI before activating updates.",
          }
        : {}),
      releases,
      staged,
      channel: this.channel,
    };
  }
  async check() {
    if (!this.channel)
      throw problem("Configure an HTTPS release channel on the server first.", 409);
    const base = new URL(this.channel.endsWith("/") ? this.channel : `${this.channel}/`);
    if (base.protocol !== "https:" || base.username || base.password)
      throw problem("Release channel must use HTTPS without embedded credentials.");
    let manifest;
    try {
      manifest = JSON.parse(
        await download(new URL("latest.json", base).href, this.fetchImpl, 1024 * 1024),
      );
    } catch (error) {
      if (error.status) throw error;
      throw problem("Release channel manifest is invalid.");
    }
    releaseVersion(manifest.version);
    const platform = `${process.platform}-${process.arch}`,
      artifact = manifest.artifacts?.[platform];
    if (
      !artifact ||
      !/^[A-Za-z0-9._-]+\.aprelease$/.test(artifact.file) ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      manifest.schemaVersion !== 1
    )
      throw problem("Release artifact is missing or incompatible.", 409);
    const current = this.status().current;
    const plan = {
      current,
      version: manifest.version,
      upToDate: current === manifest.version,
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
      throw problem("Configure an install root before staging a release.", 409);
    if (
      this.dataDir === this.installRoot ||
      this.dataDir.startsWith(`${this.installRoot}/releases/`) ||
      this.dataDir.startsWith(`${this.installRoot}/current/`)
    )
      throw problem(
        "The data directory must be outside versioned release directories.",
        409,
      );
    let bytes, plan;
    if (archive) bytes = readFile(archive, RELEASE_LIMIT);
    else {
      const reviewed = readJson(path.join(this.directory, "candidate.json"), null);
      plan = await this.check();
      if (
        plan.version !== version ||
        (reviewed &&
          (reviewed.version !== plan.version || reviewed.sha256 !== plan.sha256))
      )
        throw problem("Release channel changed; review the new candidate.", 409);
      bytes = await download(
        new URL(plan.file, this.channel.endsWith("/") ? this.channel : `${this.channel}/`)
          .href,
        this.fetchImpl,
        RELEASE_LIMIT,
      );
      if (digest(bytes) !== plan.sha256) throw problem("Release checksum mismatch.");
    }
    const root = folder(this.installRoot),
      stage = folder(path.join(root, `.staging-${randomUUID()}`));
    try {
      const manifest = unpackRelease(bytes, stage);
      requireDataCompatibility(manifest, this.dataDir);
      if (version && manifest.version !== version)
        throw problem("Release archive version does not match selection.");
      await this.smoke(stage);
      const destination = path.join(
        folder(path.join(root, "releases")),
        manifest.version,
      );
      if (fs.existsSync(destination))
        throw problem("That immutable release already exists.", 409);
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
    if (!this.installRoot) throw problem("A versioned installation is required.", 409);
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
