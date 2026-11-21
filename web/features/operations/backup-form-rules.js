// Pure rules of the backup and restore dialogs (BackupForm, RestoreForm).
import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";

// The server's minimum for a backup passphrase (operations/archive.js).
export const PASSPHRASE_MIN = 12;
/** What is wrong with a backup passphrase, or "" when it is long enough. */
export const passphraseProblem = (value) =>
  !value
    ? copy.passphraseRequired
    : value.length < PASSPHRASE_MIN
      ? copy.passphraseTooShort(PASSPHRASE_MIN)
      : "";

/**
 * The first unfilled restore input and its explanation; null when restore may start.
 * A project without a folder stays historical (docs/operations.md, Restore contract).
 */
export function restoreGap({ inspection, targetDataDir, passphrase }) {
  if (!targetDataDir.trim())
    return { field: "target", message: copy.restoreTargetRequired };
  if (inspection.requiresPassphrase && !passphrase)
    return { field: "passphrase", message: copy.restorePassphraseRequired };
  return null;
}
/** The mapping the restore sends: only the projects given a folder. */
export const filledProjectMap = (projectMap) =>
  Object.fromEntries(
    Object.entries(projectMap)
      .map(([id, cwd]) => [id, cwd.trim()])
      .filter(([, cwd]) => cwd),
  );
