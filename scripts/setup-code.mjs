import path from "node:path";
import { isMainModule } from "../server/lib/is-main-module.js";
import { serverMessages } from "../server/lib/i18n/de.js";
import { loadConfig } from "../server/lib/config.js";
import { readJSON } from "../server/lib/storage.js";
import { SetupCode } from "../server/features/login/setup-code.js";

/** Whether an owner, or users without one, exist: read as the service reads them. */
function accounts(dataDir) {
  const auth = readJSON(path.join(dataDir, "login", "auth.json"), null);
  const users = readJSON(path.join(dataDir, "users", "users.json"), null);
  return {
    owner: Boolean(auth?.user),
    users: Array.isArray(users?.users) && users.users.length > 0,
  };
}

/**
 * The line the service and remote commands add while the owner can still be created
 * over the plain network: the setup code, created when there is none. Null otherwise.
 */
export function setupCodeNotice({ dataDir, networkEnabled }) {
  const { owner, users } = accounts(dataDir);
  if (!networkEnabled || owner || users) return null;
  return serverMessages.scripts.setupCodeStart(new SetupCode({ dataDir }).current());
}

/**
 * Prints the one-time code the setup form asks for when the owner account is created
 * over the plain network (docs/login.md). The running service reads the same file, so
 * a code created here is valid at once; with an owner there is none.
 */
export function runSetupCode({ dataDir, log = console.log }) {
  const setupCode = new SetupCode({ dataDir });
  const { owner, users } = accounts(dataDir);
  if (owner) {
    setupCode.clear();
    log(serverMessages.scripts.setupCodeOwnerExists);
  } else if (users) log(serverMessages.scripts.setupCodeUsersExist);
  else log(serverMessages.scripts.setupCodeShown(setupCode.current()));
  return 0;
}
if (isMainModule(import.meta.url))
  process.exit(runSetupCode({ dataDir: loadConfig().dataDir }));
