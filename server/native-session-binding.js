import { isMainModule } from "./lib/is-main-module.js";
// Stable executable path retained for configurations of already-running sessions.
import { runNativeSessionHook } from "./features/sessions/native-session-binding.js";
if (isMainModule(import.meta.url) && process.argv[2] === "--record")
  await runNativeSessionHook();
