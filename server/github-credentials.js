import { isMainModule } from "./lib/is-main-module.js";
// Stable executable path retained for configurations of already-running sessions.
import { runGitCredentialCommand } from "./features/repositories/github-credentials.js";
if (isMainModule(import.meta.url) && process.argv[2] === "--git-credential")
  await runGitCredentialCommand();
