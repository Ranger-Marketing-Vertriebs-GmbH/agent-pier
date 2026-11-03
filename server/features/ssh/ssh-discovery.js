import { serverMessages } from "../../lib/i18n/de.js";
import { fileURLToPath } from "node:url";
import { isCodingCli } from "../clis/catalog.js";
import { cliDriver } from "../clis/drivers.js";
import { failure } from "../memory/memory-validation.js";

const script = fileURLToPath(new URL("./ssh-hook.js", import.meta.url));
const pluginUrl = new URL("./ssh-opencode.js", import.meta.url).href;

// Called with the launch's private args/env copies and the existing Claude plugin folder.
export function prepareSshDiscovery({ tool, folder, args, env }) {
  // A tool without a start hook (no coding CLI) gets none.
  if (!isCodingCli(tool)) return;
  const invalid = () =>
    Object.assign(failure(serverMessages.ssh.discoveryFailed, 409), {
      code: "SSH_DISCOVERY_CONFIG",
    });
  cliDriver(tool).addReminder(
    { args, env },
    { name: "SSH", script, pluginUrl, folder, invalid },
  );
}
