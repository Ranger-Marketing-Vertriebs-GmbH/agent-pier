import fs from "node:fs";
import {
  accountAttachmentDirectory,
  attachmentDirectory,
} from "../chat/chat-attachments.js";
import { isCodingCli } from "../clis/catalog.js";
import { cliDriver } from "../clis/drivers.js";

/**
 * The session directory lives under a path this process does not fully
 * control (the account subtree may be missing, occupied by a non-directory,
 * read-only, out of space, …). Same rule as the OpenCode grant
 * (clis/opencode/attachments.js): a launch must never fail because of this
 * grant, so any mkdir failure here is swallowed and reported as "no grant"
 * rather than propagated.
 */
function ensureAttachmentDirectory(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

export function grantAttachmentAccess({
  tool,
  dataDir,
  accountId,
  sessionId,
  launch,
  profile,
}) {
  if (!isCodingCli(tool)) return null;
  const directory = attachmentDirectory(dataDir, accountId, sessionId);
  // `profile` is a function returning the profile location; only a CLI that grants
  // through its profile calls it. The driver adds its grant to launch.args.
  const granted = cliDriver(tool).grantDirectory(launch, directory, {
    reload: false,
    ensure: () => ensureAttachmentDirectory(directory),
    profile,
    accountDirectory: accountAttachmentDirectory(dataDir, accountId),
  });
  return granted ? { directory } : null;
}

/**
 * Pairs with grantAttachmentAccess: removes the per-session directory a
 * failed launch already created (before any session record exists to find
 * it through). The opencode account-level config reference is left alone —
 * it is shared across that account's sessions and still valid.
 */
export function discardAttachmentAccess(attachments) {
  if (attachments?.directory)
    fs.rmSync(attachments.directory, { recursive: true, force: true });
}
