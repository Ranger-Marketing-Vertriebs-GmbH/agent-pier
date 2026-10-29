// Removes AgentPier's marked block from ~/.ssh/config (docs/installation.md, Stop and
// remove): `node scripts/ssh-config.mjs remove`. Every other line stays.
import { isMainModule } from "../server/lib/is-main-module.js";
import { serverMessages } from "../server/lib/i18n/de.js";
import { loadConfig } from "../server/lib/config.js";
import { removeSshConfigInclude } from "../server/features/ssh/ssh-user-config.js";

export function runSshConfig({ action, home = loadConfig().home, log = console.log }) {
  if (action !== "remove") throw new Error(serverMessages.scripts.sshConfigUsage);
  try {
    const result = removeSshConfigInclude({ home });
    log(
      result === "removed"
        ? serverMessages.scripts.sshConfigRemoved
        : serverMessages.scripts.sshConfigAbsent,
    );
    return 0;
  } catch (error) {
    if (!error?.code?.startsWith("SSH_CONFIG_")) throw error;
    log(serverMessages.scripts.sshConfigRefused(error.code));
    return 1;
  }
}

if (isMainModule(import.meta.url))
  try {
    process.exitCode = runSshConfig({ action: process.argv[2] });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
