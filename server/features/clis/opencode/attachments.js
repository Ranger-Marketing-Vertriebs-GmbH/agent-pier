// How an OpenCode session reaches its chat attachments: an account-scoped references
// entry in the profile's opencode.json, since OpenCode has no --add-dir.
import path from "node:path";
import { readConfig, updateConfig } from "../../extensions/mcp-config.js";

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
export function grantOpenCode(profile, directory) {
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
