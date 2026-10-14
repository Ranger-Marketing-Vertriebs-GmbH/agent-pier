import { isMainModule } from "./lib/is-main-module.js";
// Stable executable path of the session git credential helper. New sessions start
// it from here, and configurations of already-running sessions may reference it.
// It imports only the dependency-light helper, never the server module graph.
import { runGitCredentialCommand } from "./features/repositories/session-git-credential.js";
if (isMainModule(import.meta.url) && process.argv[2] === "--git-credential")
  await runGitCredentialCommand();
