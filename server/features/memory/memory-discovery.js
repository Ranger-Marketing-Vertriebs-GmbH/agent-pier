import { serverMessages } from "../../lib/i18n/de.js";
import { fileURLToPath } from "node:url";
import { isCodingCli } from "../clis/catalog.js";
import { cliDriver } from "../clis/drivers.js";
import { failure } from "./memory-validation.js";

const script = fileURLToPath(new URL("./memory-hook.js", import.meta.url));
const plugin = new URL("./memory-opencode.js", import.meta.url).href;

// Called with the launch's private args/env copies and the existing Claude plugin folder.
export function prepareMemoryDiscovery({ tool, folder, args, env }) {
  // A tool without a start hook (no coding CLI) gets none.
  if (!isCodingCli(tool)) return;
  const invalid = () =>
    Object.assign(failure(serverMessages.memory.discoveryFailed, 409), {
      code: "MEMORY_DISCOVERY_CONFIG",
    });
  cliDriver(tool).addReminder(
    { args, env },
    { name: "MEMORY", script, plugin, folder, invalid },
  );
}
