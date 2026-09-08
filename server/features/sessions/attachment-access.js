import fs from "node:fs";
import path from "node:path";
import { readConfig, updateConfig } from "../extensions/mcp-config.js";
import {
  accountAttachmentDirectory,
  attachmentDirectory,
} from "../chat/chat-attachments.js";

const REFERENCE_ALIAS = "agentpier-attachments";

/**
 * OpenCode has no --add-dir; its references entry is account-scoped so it cannot
 * grow per session. Routed through the same atomic, boundary-checked config
 * machinery as every other CLI-config write (readConfig/updateConfig), so a
 * symlinked or mid-write config can't be corrupted or escaped. Returns false
 * without writing anything when there is no profile to write into, the entry
 * cannot be read or written (malformed JSON, a symlinked config file,
 * duplicate keys, a concurrent write, …), or the entry is already correct.
 *
 * A launch must never fail because of this grant: the honest outcome for an
 * unwritable config is a session with no attachments, not an aborted launch.
 * Every failure here is therefore swallowed rather than propagated.
 */
function grantOpenCode(profile, directory) {
  if (!profile?.root) return false;
  const file = path.join(profile.root, "opencode.json");
  try {
    const config = readConfig(file, profile.boundary, "opencode");
    if (config.data?.references?.[REFERENCE_ALIAS]?.path === directory) return true;
    updateConfig(config, profile.boundary, "opencode", "references", REFERENCE_ALIAS, {
      path: directory,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The session directory lives under a path this process does not fully
 * control (the account subtree may be missing, occupied by a non-directory,
 * read-only, out of space, …). Same rule as grantOpenCode: a launch must
 * never fail because of this grant, so any mkdir failure here is swallowed
 * and reported as "no grant" rather than propagated.
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
  if (!["claude", "codex", "opencode"].includes(tool)) return null;
  const directory = attachmentDirectory(dataDir, accountId, sessionId);
  if (tool === "opencode") {
    if (!grantOpenCode(profile, accountAttachmentDirectory(dataDir, accountId)))
      return null;
    if (!ensureAttachmentDirectory(directory)) return null;
    return { directory };
  }
  if (!ensureAttachmentDirectory(directory)) return null;
  launch.args.push("--add-dir", directory);
  return { directory };
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
