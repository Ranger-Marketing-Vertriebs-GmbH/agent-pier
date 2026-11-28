import fs from "node:fs";
import { run as runTool } from "../tools/tool-run.js";
import {
  androidManifest,
  androidPlatform,
  diskBytes,
  downloadBytes,
} from "./android-manifest.js";
import {
  ensureSdk,
  installedSdk,
  pruneImages,
  removeSdk,
  sweepSdk,
} from "./android-sdk-install.js";
import { hostProblem } from "./device-availability.js";
import { devicePaths } from "./device-paths.js";
import { readDeviceSettings, writeDeviceSettings } from "./device-settings.js";

/*
 * The installation of the Android SDK components as the owner sees it: one job at a
 * time (install, update or remove) with its own state and failure codes, in the
 * style of the semantic memory switch rather than the shared tool installer, because
 * the download is large, resumable and shows its progress.
 *
 * What is installed is read from the receipts on disk (android-sdk-install.js); the
 * request, the accepted terms, the last failure and a marker for the running
 * operation live in `devices/settings.json` (device-settings.js). A marker left by a
 * process that ended is an interrupted installation (`recover`).
 *
 * The owner accepts Google's terms once, with the pinned versions recorded. A later
 * release that pins other versions updates without asking again (`resume`, at
 * server start): emulator and platform tools in place, a new image beside the old
 * one, which stays while a device record names it (`imagesInUse`). An update runs
 * only while no device runs (`inUse`).
 */
const failure = (code, status = 409, detail) =>
  Object.assign(Error(code), { code, status, ...(detail && { detail }) });

export class AndroidSdk {
  /**
   * - `changed()`: the status changed (the live topic is signalled).
   * - `inUse()`: a device runs, starts or stops; `imagesInUse()`: the image ids the
   *   device records name.
   * - `problem()`: why this host cannot run devices (hostProblem), `fetchImpl`, `run`
   *   and `now`; tests replace them.
   */
  constructor({
    dataDir,
    manifest = androidManifest,
    host = { platform: process.platform, arch: process.arch },
    changed = () => {},
    inUse = () => false,
    imagesInUse = () => [],
    problem = () => hostProblem({ ...host, manifest }),
    fetchImpl = fetch,
    run = runTool,
    now = Date.now,
  }) {
    Object.assign(this, { dataDir, manifest, host, inUse, imagesInUse, problem });
    Object.assign(this, { fetchImpl, run, now, notify: changed });
    this.key = androidPlatform(host.platform, host.arch);
    this.paths = devicePaths(dataDir, manifest, host);
    // The running job: `{ kind, phase, progress, updating, controller, promise }`.
    this.operation = null;
    this.closed = false;
  }
  settings() {
    return readDeviceSettings(this.dataDir);
  }
  save(patch) {
    return writeDeviceSettings(this.dataDir, patch);
  }
  installed() {
    return installedSdk(this.paths, this.manifest, this.key);
  }
  // Emulator, platform tools and an image are there, whatever their versions.
  usable(installed = this.installed()) {
    return !!(installed.emulator && installed.platformTools && installed.images.length);
  }
  /**
   * What the previous AgentPier process did not finish: an installation becomes the
   * failure DEVICES_INTERRUPTED (its partial downloads stay, so the owner's next
   * attempt continues them), a removal is completed.
   */
  recover() {
    const { operation } = this.settings();
    if (this.operation || !operation) return;
    sweepSdk(this.paths);
    if (operation.kind === "remove") {
      for (const directory of [this.paths.sdk, this.paths.downloads, this.paths.home])
        fs.rmSync(directory, { recursive: true, force: true });
      this.save({ operation: null, requested: false, terms: null, failure: null });
    } else
      this.save({
        operation: null,
        failure: { code: "DEVICES_INTERRUPTED", at: this.now() },
      });
    this.notify();
  }
  /** Null, a host code, or DEVICES_NOT_INSTALLED: why no device can run now. */
  available() {
    const reason = this.problem();
    if (reason) return reason;
    return this.operation?.kind !== "remove" && this.usable()
      ? null
      : "DEVICES_NOT_INSTALLED";
  }
  status() {
    const { manifest, key, operation } = this;
    const settings = this.settings();
    const installed = this.installed();
    const reason = this.problem();
    const any = !!(
      installed.emulator ||
      installed.platformTools ||
      installed.images.length
    );
    const state = operation
      ? operation.phase
      : this.usable(installed)
        ? "installed"
        : settings.failure
          ? "failed"
          : "absent";
    return {
      available: !reason,
      reason,
      state,
      updating: !!operation?.updating,
      progress: operation?.progress ?? null,
      failure: settings.failure,
      requested: settings.requested,
      terms: {
        accepted: !!settings.terms,
        acceptedAt: settings.terms?.acceptedAt ?? null,
        by: settings.terms?.by ?? null,
      },
      pinned: {
        emulator: manifest.emulator.version,
        platformTools: manifest.platformTools.version,
        image: {
          id: manifest.image.id,
          api: manifest.image.api,
          tag: manifest.image.tag,
          abi: manifest.image.archives[key]?.abi ?? null,
        },
        downloadBytes: downloadBytes(manifest, key),
        diskBytes: diskBytes(manifest, key),
      },
      installed: any
        ? {
            emulator: installed.emulator,
            platformTools: installed.platformTools,
            images: installed.images,
          }
        : null,
      sources: manifest.hosts,
      licences: manifest.licences,
    };
  }
  /**
   * Starts installing the pinned components (or updating installed ones) and answers
   * status() at once; the work continues in the background and reports through
   * `changed()`. Throws a host code, DEVICES_TERMS_REQUIRED (400) unless
   * `acceptTerms` is true, DEVICES_OPERATION_RUNNING, or DEVICES_IN_USE when an
   * update would replace the emulator under a running device.
   */
  install({ acceptTerms, by = "owner" } = {}) {
    const reason = this.problem();
    if (reason) throw failure(reason);
    if (acceptTerms !== true) throw failure("DEVICES_TERMS_REQUIRED", 400);
    if (this.operation || this.closed) throw failure("DEVICES_OPERATION_RUNNING");
    const terms = {
      acceptedAt: this.now(),
      by,
      versions: {
        emulator: this.manifest.emulator.version,
        platformTools: this.manifest.platformTools.version,
        image: this.manifest.image.id,
      },
    };
    if (this.installed().current) {
      this.save({ requested: true, terms, failure: null });
      this.notify();
      return this.status();
    }
    if (this.inUse()) throw failure("DEVICES_IN_USE");
    this.save({ requested: true, terms });
    return this.begin();
  }
  // The background installation; the caller made sure nothing else runs.
  begin() {
    const controller = new AbortController();
    const operation = {
      kind: "install",
      phase: "downloading",
      progress: null,
      updating: this.usable(),
      controller,
      shutdown: false,
    };
    this.operation = operation;
    this.save({ failure: null, operation: { kind: "install", startedAt: this.now() } });
    let step = "";
    const onProgress = ({ component, phase, received, total }) => {
      operation.phase = phase;
      operation.progress = { component, received, total };
      // The topic is signalled per component, phase and percent, not per chunk.
      const next = `${component} ${phase} ${Math.floor((received * 100) / (total || 1))}`;
      if (next === step) return;
      step = next;
      this.notify();
    };
    operation.promise = ensureSdk({
      paths: this.paths,
      manifest: this.manifest,
      key: this.key,
      fetchImpl: this.fetchImpl,
      run: this.run,
      signal: controller.signal,
      onProgress,
      keepImages: this.imagesInUse(),
    })
      .then(
        () => this.save({ operation: null, failure: null }),
        (error) => {
          // A shutdown leaves the request pending: the next start continues it.
          if (operation.shutdown) return this.save({ operation: null });
          // The owner's cancel: no failure, and no request left to resume.
          if (controller.signal.aborted)
            return this.save({ operation: null, requested: false });
          return this.save({
            operation: null,
            failure: {
              code: error.code,
              at: this.now(),
              ...(error.detail && { detail: error.detail }),
            },
          });
        },
      )
      .catch((error) => console.warn("Android SDK installation state:", error.message))
      .finally(() => {
        this.operation = null;
        this.notify();
      });
    this.notify();
    return this.status();
  }
  /** Stops a running installation; partial downloads stay for the next attempt. */
  cancel() {
    if (this.operation?.kind === "install") this.operation.controller.abort();
    return this.status();
  }
  /**
   * Removes the SDK in the background and answers status() at once. Throws
   * DEVICES_OPERATION_RUNNING, or DEVICES_IN_USE while a device runs. The caller
   * removes the devices first.
   */
  remove() {
    if (this.operation || this.closed) throw failure("DEVICES_OPERATION_RUNNING");
    if (this.inUse()) throw failure("DEVICES_IN_USE");
    const operation = {
      kind: "remove",
      phase: "removing",
      progress: null,
      updating: false,
    };
    this.operation = operation;
    this.save({ operation: { kind: "remove", startedAt: this.now() } });
    operation.promise = removeSdk(this.paths)
      .then(
        () =>
          this.save({ operation: null, requested: false, terms: null, failure: null }),
        () =>
          this.save({
            operation: null,
            failure: { code: "DEVICES_INSTALL_FAILED", at: this.now() },
          }),
      )
      .catch((error) => console.warn("Android SDK removal state:", error.message))
      .finally(() => {
        this.operation = null;
        this.notify();
      });
    this.notify();
    return this.status();
  }
  /**
   * At server start, after recover(): continues a request that is still pending (the
   * installer option's, or one a shutdown interrupted) and brings an installed SDK
   * to a newer pin, without asking for the terms again. Nothing happens on a host
   * that cannot run devices, without accepted terms, or while a device runs.
   */
  resume() {
    const settings = this.settings();
    if (this.operation || this.closed || this.problem() || !settings.terms)
      return this.status();
    const installed = this.installed();
    if (installed.current) {
      // An image no device names any more leaves with the next start.
      pruneImages(this.paths, [this.manifest.image.id, ...this.imagesInUse()]);
      return this.status();
    }
    const behind = this.usable(installed);
    const pending = settings.requested && !settings.failure;
    if ((!behind && !pending) || this.inUse()) return this.status();
    return this.begin();
  }
  /** Stops a running job for a shutdown; an installation continues at the next start. */
  async close() {
    this.closed = true;
    const { operation } = this;
    if (!operation) return;
    if (operation.kind === "install") {
      operation.shutdown = true;
      operation.controller.abort();
    }
    await operation.promise;
  }
}
