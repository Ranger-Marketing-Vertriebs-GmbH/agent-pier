import path from "node:path";
import { isMainModule } from "../server/lib/is-main-module.js";
import { serverMessages } from "../server/lib/i18n/de.js";
import { loadConfig } from "../server/lib/config.js";
import { readJSON } from "../server/lib/storage.js";
import { SetupCode } from "../server/features/login/setup-code.js";

/**
 * Prints the one-time code the setup form asks for when the owner account is created
 * over the plain network (docs/login.md). The running service reads the same file, so
 * a code created here is valid at once; with an owner there is none.
 */
export function runSetupCode({ dataDir, log = console.log }) {
  const setupCode = new SetupCode({ dataDir });
  const auth = readJSON(path.join(dataDir, "login", "auth.json"), null);
  if (auth?.user) {
    setupCode.clear();
    log(serverMessages.scripts.setupCodeOwnerExists);
    return 0;
  }
  log(serverMessages.scripts.setupCodeShown(setupCode.current()));
  return 0;
}
if (isMainModule(import.meta.url))
  process.exit(runSetupCode({ dataDir: loadConfig().dataDir }));
