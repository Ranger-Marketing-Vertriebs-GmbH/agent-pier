import path from "node:path";
import { readJSON } from "../../lib/storage.js";
import { readAssistantFeature, writeAssistantFeature } from "./assistant-feature.js";
import {
  provisionEnabledRuntime,
  sameRuntime,
  stageAssistantRuntime,
} from "./runtime-install.js";
import { runtimeManifest } from "./runtime-manifest.js";

// Only a stable code is reported; installer errors can carry private paths.
const stableCode = (error, fallback) =>
  /^[A-Z][A-Z0-9_]*$/.test(error?.code || "") ? error.code : fallback;
const current = (runtime, manifest) =>
  !!runtime &&
  runtime.version === manifest.version &&
  runtime.nodeVersion === manifest.nodeVersion &&
  runtime.dependencyLockSha256 === manifest.dependencyLockSha256;

/**
 * True when an enabled installation selected a runtime that this AgentPier version
 * no longer ships and no matching candidate is staged yet. Never creates storage.
 */
export function runtimeStagingDue(dataDir, manifest = runtimeManifest) {
  if (!readAssistantFeature(dataDir).enabled) return false;
  const root = path.join(dataDir, "assistants");
  const selected = readJSON(path.join(root, "runtime.json"), null);
  if (!selected || current(selected, manifest)) return false;
  return !current(readJSON(path.join(root, "candidate.json"), null), manifest);
}

/**
 * After an AgentPier update, prepares the runtime the new version ships through the
 * shared staging path and installation lock. It never blocks the caller, never
 * changes the selection and never activates anything; the owner activates later.
 * Returns the background job, or null when nothing is due.
 */
export function stageRuntimeInBackground(
  options,
  { stage = stageAssistantRuntime } = {},
) {
  let due;
  try {
    due = runtimeStagingDue(options.dataDir, options.manifest);
  } catch {
    due = false;
  }
  if (!due) return null;
  return new Promise((resolve) => setImmediate(resolve))
    .then(() => stage(options))
    .catch((error) => {
      const code = stableCode(error, "RUNTIME_STAGING_FAILED");
      console.error(`AgentPier could not prepare the assistant runtime: ${code}`);
      return null;
    });
}

/**
 * Installer step: `--with-assistants` enables the feature first; an installation
 * that already has assistants enabled is provisioned too. Neither unsafe storage nor
 * a failed download fails the AgentPier installation; a stable code is reported and
 * the runtime is installed on the first assistant start. A runtime staged next to an
 * existing selection is reported as `staged`; activation remains an owner action.
 */
export async function provisionInstallerRuntime(
  { dataDir, enable = false },
  { assistantRuntime = provisionEnabledRuntime } = {},
) {
  try {
    if (enable) writeAssistantFeature(dataDir, { enabled: true });
    if (!readAssistantFeature(dataDir).enabled) return null;
    const runtime = await assistantRuntime({ dataDir });
    const selected = readJSON(path.join(dataDir, "assistants", "runtime.json"), null);
    if (selected && runtime && !sameRuntime(selected, runtime))
      return { status: "staged", version: runtime.version, selected: selected.version };
    const version = selected?.version || runtime?.version;
    return { status: "ready", ...(version ? { version } : {}) };
  } catch (error) {
    return { status: "failed", code: stableCode(error, "RUNTIME_PROVISIONING_FAILED") };
  }
}
