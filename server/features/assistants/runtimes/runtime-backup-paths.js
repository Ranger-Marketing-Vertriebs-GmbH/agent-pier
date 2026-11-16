import { hermesDescriptor } from "./hermes/descriptor.js";
import { hermesBackupPaths } from "./hermes/hermes-backup-paths.js";

// What host backups make of the folders a runtime keeps below assistants/ beside the
// shared ones (docs/backups.md). A runtime with such a folder brings predicates over
// a path relative to assistants/; the backup asks every runtime and
// names none. OpenClaw's state is the shared layout the backup knows itself
// (operations/private-content.js, backup-credentials.js).
//
// This module imports only the runtimes' path rules, so the backup and restore code
// loads no adapter. Read at each call: no module order matters.
const byRuntime = () => ({ [hermesDescriptor.id]: hermesBackupPaths });
const rules = () => Object.values(byRuntime());

/**
 * The ids of the runtimes that bring backup rules. Every runtime with a host per
 * agent keeps private folders and must be among them (runtime-wiring.test.js).
 */
export const backupRuleRuntimes = () => Object.keys(byRuntime());

/** Whether `relative` is a runtime's data no host backup archives. */
export const isRuntimeExcluded = (relative) =>
  rules().some((paths) => paths.excluded(relative));

/** Whether `relative` is (in) a runtime's agent browser profile, archived sealed only. */
export const isRuntimeBrowserTree = (relative) =>
  rules().some((paths) => paths.browserTree(relative));

/**
 * Whether `relative` is a credential file in a runtime's private folder, which travels
 * only sealed (backup-credentials.js isCredentialFile).
 */
export const isRuntimeCredential = (relative) =>
  rules().some((paths) => paths.credential(relative));

/**
 * The same for a path relative to a runtime's own folder, as the update journal of a
 * runtime with agent folders of its own snapshots it (runtime-update-snapshot.js).
 */
export const isRuntimeSnapshotCredential = (relative) =>
  rules().some((paths) => paths.snapshotCredential(relative));

/**
 * Where runtimes keep agent browser profiles outside the shared browser folder, one
 * entry per runtime that does: `{ prefix, folder, homeOf(id), member(name) }`.
 * `prefix` (relative to the data directory) holds one home per agent, `homeOf` names
 * the home of the agent with the stored id `id` (null for none), `folder` is the
 * profile's folder in it, and `member` tells a profile file by its member name.
 */
export const runtimeBrowserProfiles = () =>
  rules()
    .map((paths) => paths.browserProfiles)
    .filter(Boolean);

/** Whether `relative` is or lies in a runtime's private folder. */
export const isPrivateRuntimeTree = (relative) =>
  rules().some((paths) => paths.privateTree(relative));
