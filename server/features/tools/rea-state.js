import { serverMessages } from "../../lib/i18n/de.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";

/**
 * The stable key (and arguments) of the German server text `text` as
 * `<prefix>Key`/`<prefix>Args`: the browser shows the text in the owner's language
 * (web/lib/server-messages.js), as with every other server message.
 */
export function keyed(prefix, text) {
  const { messageKey, messageArgs } = text ? messageIdentity(text) : {};
  return {
    ...(messageKey ? { [`${prefix}Key`]: messageKey } : {}),
    ...(messageArgs ? { [`${prefix}Args`]: messageArgs } : {}),
  };
}

const sum = (...values) => values.reduce((total, value) => total + (value ?? 0), 0);

/**
 * Ghidra (with its JDK) and frida as the REA card shows them: whether this host has
 * them and why not, what is installed and pinned, and the sizes to expect.
 * `ghidra`/`jdk` are managedReaComponent() results; `frida` whether Core has it.
 */
export function reaComponentStates({ host, manifest, ghidra, jdk, frida }) {
  const pinned = host.ghidra;
  return {
    ghidra: {
      available: !!pinned,
      reason: host.ghidraReason,
      ...keyed("reason", host.ghidraReason),
      installed: !!ghidra && !!jdk,
      version: ghidra?.version ?? null,
      pinnedVersion: manifest.ghidra.version,
      jdkVersion: jdk?.version ?? null,
      jdkPinnedVersion: manifest.jdk.version,
      downloadSize: pinned ? sum(pinned.entry.size, pinned.jdk.size) : null,
      installedSize: pinned
        ? sum(pinned.entry.installedSize, pinned.jdk.installedSize)
        : null,
    },
    frida: {
      available: !!host.frida,
      reason: host.fridaReason,
      ...keyed("reason", host.fridaReason),
      installed: !!frida && !!host.frida,
      version: frida && host.frida ? manifest.frida.version : null,
      pinnedVersion: manifest.frida.version,
      downloadSize: host.frida?.size ?? null,
      installedSize: host.frida?.installedSize ?? null,
    },
  };
}

/** Only catalog texts reach the card; anything else (paths, npm output) stays out. */
export const failureText = (error) =>
  typeof error?.status === "number" && messageIdentity(error.message).messageKey
    ? error.message
    : serverMessages.rea.failed;
