import { hermesBackupPaths } from "./hermes/hermes-backup-paths.js";

// What host backups make of the folders a runtime keeps below assistants/ beside the
// shared ones (docs/backups.md). A runtime with such a folder brings three
// predicates over a path relative to assistants/; the backup asks every runtime and
// names none. OpenClaw's state is the shared layout the backup knows itself
// (operations/private-content.js, backup-credentials.js).
//
// This module imports only the runtimes' path rules, so the backup and restore code
// loads no adapter. Read at each call: no module order matters.
const rules = () => [hermesBackupPaths];

/** Whether `relative` is a runtime's data no host backup archives. */
export const isRuntimeExcluded = (relative) =>
  rules().some((paths) => paths.excluded(relative));

/** Whether `relative` is (in) a runtime's agent browser profile, archived sealed only. */
export const isRuntimeBrowserTree = (relative) =>
  rules().some((paths) => paths.browserTree(relative));

/** Whether `relative` is or lies in a runtime's private folder. */
export const isPrivateRuntimeTree = (relative) =>
  rules().some((paths) => paths.privateTree(relative));
