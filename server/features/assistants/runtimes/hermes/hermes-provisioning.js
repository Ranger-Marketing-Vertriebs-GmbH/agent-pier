import fs from "node:fs";
import path from "node:path";
import { readJSON, writePrivate } from "../../../../lib/storage.js";
import { privateFolder } from "../../runtime-paths.js";
import { hermesManifest } from "./hermes-manifest.js";
import {
  ensureHermesRuntime,
  hasAgentBrowser,
  sameHermesRuntime,
  shippedHermesRuntime,
  stageHermesRuntime,
} from "./hermes-install.js";
import { hasPdfium } from "./hermes-pdfium.js";

// Only a stable code is reported; installer errors can carry private paths.
const stableCode = (error, fallback) =>
  /^[A-Z][A-Z0-9_]*$/.test(error?.code || "") ? error.code : fallback;

// The assistants settings store (`<data>/assistants/settings.json`) keeps the runtime
// switch as `enabled` and the Hermes opt-in as `hermes.enabled`.
const settingsFile = (dataDir) => path.join(dataDir, "assistants", "settings.json");
const readSettings = (dataDir) => {
  try {
    const value = readJSON(settingsFile(dataDir), {});
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};

/** Whether the owner opted into Hermes Agent. Never creates storage. */
export const hermesEnabled = (dataDir) => readSettings(dataDir).hermes?.enabled === true;

/** Records the Hermes opt-in; the other settings of the store stay as they are. */
export function writeHermesEnabled(dataDir, enabled) {
  privateFolder(path.join(dataDir, "assistants"));
  writePrivate(settingsFile(dataDir), {
    ...readSettings(dataDir),
    hermes: { enabled: enabled === true },
  });
}

const records = (dataDir) => {
  const root = path.join(dataDir, "assistants", "hermes");
  return {
    selected: readJSON(path.join(root, "runtime.json"), null),
    candidate: readJSON(path.join(root, "candidate.json"), null),
  };
};

/** Whether a Hermes installation is selected. Never creates storage. */
export const hermesInstalled = (dataDir) => {
  try {
    return !!records(dataDir).selected;
  } catch {
    return false;
  }
};

/** Whether Hermes agents may run: the owner enabled Hermes and it is installed. */
export const hermesRunnable = (dataDir) =>
  hermesEnabled(dataDir) && hermesInstalled(dataDir);

/**
 * True when Hermes is enabled and nothing selected or staged is the pinned runtime
 * this AgentPier ships: a fresh opt-in without an installation, or an AgentPier
 * update that pins another Hermes; or when the pinned one lacks its agent-browser
 * or PDFium.
 * Never creates storage.
 */
export function hermesStagingDue(dataDir, manifest = hermesManifest) {
  if (!hermesEnabled(dataDir)) return false;
  if (!fs.existsSync(path.join(dataDir, "assistants"))) return true;
  const { selected, candidate } = records(dataDir);
  // The pinned release installed before the browser lacks its agent-browser, one
  // installed before the pdf tool its PDFium: the staging adds them in place
  // (hermes-install.js installAgentBrowser, hermes-pdfium.js installPdfium).
  if (shippedHermesRuntime(selected, manifest))
    return (
      !hasAgentBrowser(selected.directory, manifest) ||
      !hasPdfium(selected.directory, manifest)
    );
  return !shippedHermesRuntime(candidate, manifest);
}

/**
 * At server start (after an AgentPier update too): installs the pinned Hermes in the
 * background when it is due. The first installation is selected; a newer pin is
 * staged beside the selected one and activated through the update journal. Never
 * blocks the caller; the job, or null when nothing is due.
 */
export function stageHermesInBackground(
  options,
  { ensure = ensureHermesRuntime, stage = stageHermesRuntime } = {},
) {
  let due;
  try {
    due = hermesStagingDue(options.dataDir, options.manifest);
  } catch {
    due = false;
  }
  if (!due) return null;
  const fresh = !records(options.dataDir).selected;
  return new Promise((resolve) => setImmediate(resolve))
    .then(() => (fresh ? ensure(options) : stage(options)))
    .catch((error) => {
      const code = stableCode(error, "HERMES_STAGING_FAILED");
      console.error(`AgentPier could not prepare the Hermes runtime: ${code}`);
      return null;
    });
}

/**
 * Installer step `--with-hermes`: records the opt-in, then installs the pinned Hermes;
 * an installation that already has Hermes enabled is provisioned too. A failed
 * download never fails the AgentPier installation: a stable code is reported and the
 * runtime is installed at the next server start.
 */
export async function provisionInstallerHermes(
  { dataDir, enable = false },
  { ensure = ensureHermesRuntime } = {},
) {
  try {
    if (enable) writeHermesEnabled(dataDir, true);
    if (!hermesEnabled(dataDir)) return null;
    const runtime = await ensure({ dataDir });
    const { selected } = records(dataDir);
    if (selected && runtime && !sameHermesRuntime(selected, runtime))
      return { status: "staged", version: runtime.version, selected: selected.version };
    return { status: "ready", version: (selected || runtime).version };
  } catch (error) {
    return { status: "failed", code: stableCode(error, "HERMES_PROVISIONING_FAILED") };
  }
}

/**
 * The owner's Hermes switch (no UI yet): `state()` reports the opt-in and the
 * installation, `enable()` records it and starts the installation in the background,
 * `disable()` records it; the installation stays for the next opt-in and runtime
 * retention. `onChange()` hears every change of state().
 */
export function createHermesSwitch({
  dataDir,
  install = ensureHermesRuntime,
  manifest = hermesManifest,
}) {
  let job = null;
  let failed = null;
  const self = {
    onChange: null,
    state() {
      const { selected, candidate } = records(dataDir);
      return {
        enabled: hermesEnabled(dataDir),
        installing: !!job,
        installed: !!selected,
        version: selected?.version || null,
        targetVersion: manifest.version,
        // Whether the selected installation is the one this AgentPier pins.
        current: shippedHermesRuntime(selected, manifest),
        // Hermes runs on its own CPython (the installation's, else the pinned one).
        pythonVersion: selected?.pythonVersion || manifest.pythonVersion || null,
        candidateReady: !!candidate && !sameHermesRuntime(candidate, selected),
        error: failed,
      };
    },
    async enable() {
      writeHermesEnabled(dataDir, true);
      failed = null;
      if (!job && hermesStagingDue(dataDir, manifest))
        job = Promise.resolve()
          .then(() => install({ dataDir }))
          .catch((error) => {
            failed = stableCode(error, "HERMES_PROVISIONING_FAILED");
          })
          .finally(() => {
            job = null;
            self.onChange?.();
          });
      return self.state();
    },
    async disable() {
      writeHermesEnabled(dataDir, false);
      return self.state();
    },
    // The running installation, for tests and shutdown.
    settled: () => job || Promise.resolve(),
  };
  return self;
}
