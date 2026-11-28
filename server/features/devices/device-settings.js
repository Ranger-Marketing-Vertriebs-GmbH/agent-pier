import path from "node:path";
import { privateDirectory, readJSON, writePrivate } from "../../lib/storage.js";

/*
 * The owner's settings for Android devices and the record of the installation, in
 * `<data>/devices/settings.json` (a feature-owned file: the installer writes a
 * request into it without loading the server, and it is not part of a backup):
 *
 *   maxDevices, maxRunning   the two limits
 *   requested                the owner (or the installer option) asked for the SDK
 *   terms                    null, or who accepted Google's terms, when, and for
 *                            which pinned versions
 *   failure                  null, or `{ code, at, detail? }` of the last failed
 *                            installation
 *   operation                null, or `{ kind: "install" | "remove", startedAt }`
 *                            while AgentPier works on the SDK; one left behind by a
 *                            process that ended is how android-sdk.js notices an
 *                            interrupted installation
 */
export const DEVICE_LIMITS = Object.freeze({
  maxDevices: Object.freeze({ default: 5, min: 1, max: 20 }),
  maxRunning: Object.freeze({ default: 2, min: 1, max: 5 }),
});

const settingsFile = (dataDir) => path.join(dataDir, "devices", "settings.json");
const invalid = () =>
  Object.assign(Error("DEVICES_SETTINGS_INVALID"), {
    code: "DEVICES_SETTINGS_INVALID",
    status: 400,
  });
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const within = (value, { min, max }) =>
  Number.isInteger(value) && value >= min && value <= max;
const text = (value) => typeof value === "string" && value.length > 0;

// What each field may hold; anything else in a stored file reads as the default.
const fields = {
  maxDevices: {
    fallback: DEVICE_LIMITS.maxDevices.default,
    valid: (value) => within(value, DEVICE_LIMITS.maxDevices),
  },
  maxRunning: {
    fallback: DEVICE_LIMITS.maxRunning.default,
    valid: (value) => within(value, DEVICE_LIMITS.maxRunning),
  },
  requested: { fallback: false, valid: (value) => typeof value === "boolean" },
  terms: {
    fallback: null,
    valid: (value) =>
      value === null ||
      (record(value) &&
        Number.isFinite(value.acceptedAt) &&
        ["owner", "installer"].includes(value.by) &&
        record(value.versions)),
  },
  failure: {
    fallback: null,
    valid: (value) =>
      value === null || (record(value) && text(value.code) && Number.isFinite(value.at)),
  },
  operation: {
    fallback: null,
    valid: (value) =>
      value === null ||
      (record(value) &&
        ["install", "remove"].includes(value.kind) &&
        Number.isFinite(value.startedAt)),
  },
};

/** The stored settings with defaults; a damaged or missing file reads as defaults. */
export function readDeviceSettings(dataDir) {
  let stored = null;
  try {
    stored = readJSON(settingsFile(dataDir), null);
  } catch {
    // A damaged file reads as the defaults.
  }
  if (!record(stored)) stored = {};
  return Object.fromEntries(
    Object.entries(fields).map(([name, { fallback, valid }]) => [
      name,
      valid(stored[name]) ? stored[name] : fallback,
    ]),
  );
}

/**
 * Merges `patch` into the stored settings and writes them. Throws
 * DEVICES_SETTINGS_INVALID (status 400) for an unknown field or a value outside its
 * bounds; nothing is written then. Returns the settings as stored.
 */
export function writeDeviceSettings(dataDir, patch) {
  if (!record(patch)) throw invalid();
  for (const [name, value] of Object.entries(patch))
    if (!fields[name]?.valid(value)) throw invalid();
  const next = { ...readDeviceSettings(dataDir), ...patch };
  privateDirectory(path.dirname(settingsFile(dataDir)));
  writePrivate(settingsFile(dataDir), next);
  return next;
}
