import path from "node:path";
import { isMainModule } from "../server/lib/is-main-module.js";
import { ensureAssistantRuntime } from "../server/features/assistants/runtime-install.js";
export { ensureAssistantRuntime };
if (isMainModule(import.meta.url)) {
  if (
    process.argv.length !== 4 ||
    process.argv[2] !== "--data-dir" ||
    !path.isAbsolute(process.argv[3])
  )
    throw Error(
      "Usage: node scripts/install-assistant-runtime.mjs --data-dir <absolute-directory>",
    );
  console.log(JSON.stringify(await ensureAssistantRuntime({ dataDir: process.argv[3] })));
}
