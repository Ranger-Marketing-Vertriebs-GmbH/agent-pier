import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { gunzipSync } from "node:zlib";
import { Releases, download } from "../server/features/operations/releases.js";
import {
  releaseManifest,
  releaseVersion,
  RELEASE_LIMIT,
} from "../server/features/operations/release-archive.js";
import { digest, folder, readFile, atomic } from "../server/features/operations/files.js";
import {
  installLauncher,
  switchRelease,
} from "../server/features/operations/release-activation.js";
import { checkHealth } from "../server/features/operations/release-service.js";
import { ensureDependencies } from "./install-dependencies.mjs";
import { runService } from "./service.mjs";
import {
  inspectSetup,
  acquireSetupLock,
  writeReceipt,
  verifyRelease,
} from "./setup-state.mjs";
import { inspectSetupService } from "./setup-service.mjs";
const officialChannel =
  "https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/latest/download/";
function channelBase(channel) {
  const url = new URL(channel.endsWith("/") ? channel : `${channel}/`);
  if (url.protocol !== "https:" || url.username || url.password)
    throw Error("Setup channels require HTTPS without credentials.");
  return url.href;
}
async function selectTarget(archive, channel, fetchImpl) {
  if (archive) {
    const bytes = readFile(archive, RELEASE_LIMIT);
    if (bytes.length > RELEASE_LIMIT) throw Error("Release archive exceeds its limit.");
    const manifest = releaseManifest(
      JSON.parse(gunzipSync(bytes, { maxOutputLength: RELEASE_LIMIT })).manifest,
    );
    return { version: manifest.version, sha256: digest(bytes), bytes };
  }
  const manifest = JSON.parse(
    await download(new URL("latest.json", channel).href, fetchImpl, 1024 * 1024),
  );
  releaseVersion(manifest.version);
  const artifact = manifest.artifacts?.[`${process.platform}-${process.arch}`];
  if (
    manifest.schemaVersion !== 1 ||
    !artifact ||
    !/^[A-Za-z0-9._-]+\.aprelease$/.test(artifact.file) ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256)
  )
    throw Error("Release artifact is missing or incompatible.");
  const base =
    channel === officialChannel
      ? new URL(`../../download/v${manifest.version}/`, channel).href
      : channel;
  return {
    version: manifest.version,
    sha256: artifact.sha256,
    url: new URL(artifact.file, base).href,
  };
}
export async function resumeSetup(
  options,
  {
    run,
    serviceRunner = runService,
    health = checkHealth,
    inspectService = inspectSetupService,
    releaseOptions = {},
    env = process.env,
    platform = process.platform,
    home = os.homedir(),
    afterPhase = async () => {},
  } = {},
) {
  let inspected = inspectSetup(options);
  if (inspected.state === "conflict")
    throw Error(
      `Setup conflict: ${inspected.reason} Inspect --install-root and --data-dir.`,
    );
  const { installRoot, dataDir } = inspected;
  const serviceInput = { installRoot, dataDir, platform, home, env };
  const before = await inspectService(serviceInput);
  if (
    before.state === "conflict" ||
    (before.listener && before.state !== "matching") ||
    (inspected.state === "fresh" && before.state !== "missing")
  )
    throw Error(
      "Setup conflict: inspect the configured service paths and listener on port 4380.",
    );
  // Recheck after asynchronous inspection, before claiming the installation.
  inspected = inspectSetup({ installRoot, dataDir });
  if (inspected.state === "conflict") throw Error(`Setup conflict: ${inspected.reason}`);
  let channel = channelBase(
    inspected.receipt?.channel ||
      options.channel ||
      env.AGENTPIER_RELEASE_CHANNEL ||
      officialChannel,
  );
  let initialChannel = channelBase(
    inspected.receipt?.initialChannel || options.initialChannel || channel,
  );
  const fetchImpl = releaseOptions.fetchImpl || fetch;
  const target = inspected.receipt
    ? null
    : await selectTarget(options.archive, initialChannel, fetchImpl);
  // Target lookup may await the network. Another setup can finish while it runs.
  inspected = inspectSetup({ installRoot, dataDir });
  if (inspected.state === "conflict") throw Error(`Setup conflict: ${inspected.reason}`);
  channel = inspected.receipt?.channel || channel;
  initialChannel = inspected.receipt?.initialChannel || initialChannel;
  if (!fs.existsSync(installRoot))
    fs.mkdirSync(installRoot, { recursive: true, mode: 0o700 });
  const unlock = acquireSetupLock(installRoot, inspected);
  try {
    let receipt = inspected.receipt;
    const cachedArchive = path.join(installRoot, ".setup-target.aprelease");
    if (!receipt) {
      receipt = {
        schema: 1,
        installRoot,
        dataDir,
        initialVersion: target.version,
        initialChannel,
        channel,
        phase: "prepared",
        target: { sha256: target.sha256, ...(target.url ? { url: target.url } : {}) },
      };
      writeReceipt(installRoot, receipt);
      if (target.bytes) atomic(cachedArchive, target.bytes);
      await afterPhase("prepared");
    }
    const dependencies = await ensureDependencies({
      install: options.installDependencies !== false,
      platform,
      run,
      env,
    });
    folder(dataDir);
    const advance = async (phase) => {
      receipt = { ...receipt, phase };
      writeReceipt(installRoot, receipt);
      await afterPhase(phase);
    };
    let version = inspected.activeVersion;
    let launcher = path.join(installRoot, "bin/agentpier");
    if (!version) {
      version = receipt.initialVersion;
      const destination = path.join(installRoot, "releases", version);
      if (fs.existsSync(destination)) verifyRelease(installRoot, dataDir, version);
      else {
        let bytes;
        if (fs.existsSync(cachedArchive)) bytes = readFile(cachedArchive, RELEASE_LIMIT);
        else if (receipt.target.url)
          bytes = await download(receipt.target.url, fetchImpl, RELEASE_LIMIT);
        else if (options.archive) bytes = readFile(options.archive, RELEASE_LIMIT);
        else
          throw Error(
            "Original setup archive is unavailable. Retry with the original archive.",
          );
        if (digest(bytes) !== receipt.target.sha256)
          throw Error("Original setup archive checksum mismatch.");
        atomic(cachedArchive, bytes);
        await new Releases({ dataDir, installRoot, channel, ...releaseOptions }).stage({
          archive: cachedArchive,
          version,
        });
      }
      await advance("staged");
      launcher = installLauncher({ installRoot, dataDir });
      switchRelease(installRoot, version);
      await advance("selected");
    }
    if (options.service) {
      let serviceState = await inspectService(serviceInput);
      if (
        serviceState.state === "conflict" ||
        (serviceState.listener && serviceState.state !== "matching")
      )
        throw Error("Setup conflict: service or port 4380 changed during installation.");
      const alreadyHealthy =
        serviceState.state === "matching" &&
        serviceState.listener &&
        (await health({ port: 4380, version }));
      if (!alreadyHealthy) {
        await serviceRunner({
          action: "install",
          platform,
          home,
          env: {
            ...dependencies.env,
            AGENTPIER_INSTALL_ROOT: installRoot,
            AGENTPIER_DATA_DIR: dataDir,
            AGENTPIER_RELEASE_CHANNEL: serviceState.channel || channel,
          },
          config: { dataDir, port: 4380 },
        });
        await advance("service");
        const healthy = await health({ port: 4380, version });
        serviceState = await inspectService(serviceInput);
        if (serviceState.state !== "matching" || !serviceState.listener || !healthy)
          throw Error(
            "Initial service health check failed. Inspect the service logs and listener configuration; installed release and data were preserved.",
          );
      }
      await advance("healthy");
    }
    return {
      version,
      installRoot,
      dataDir,
      launcher,
      installedDependencies: dependencies.installed,
      serviceInstalled: Boolean(options.service),
      ...(options.service ? { url: "http://127.0.0.1:4380" } : {}),
    };
  } finally {
    unlock();
  }
}
