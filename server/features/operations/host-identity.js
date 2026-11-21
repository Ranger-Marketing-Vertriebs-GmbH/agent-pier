import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

let cached;

/** The machine's own identifier: Linux's machine-id, macOS's platform UUID, or null. */
function machineIdentifier() {
  for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const value = fs.readFileSync(file, "utf8").trim();
      if (/^[a-f0-9]{32}$/i.test(value)) return value;
    } catch {
      // Not this platform, or not readable: try the next source.
    }
  }
  if (process.platform !== "darwin") return null;
  try {
    const output = execFileSync(
      "/usr/sbin/ioreg",
      ["-rd1", "-c", "IOPlatformExpertDevice"],
      {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return /"IOPlatformUUID"\s*=\s*"([0-9A-F-]{36})"/i.exec(output)?.[1] || null;
  } catch {
    return null;
  }
}

/**
 * A stable, one-way fingerprint of this machine, or null when the machine names no
 * identifier. Backups record it so a restore can tell whether it runs on the host the
 * backup came from; the raw machine identifier never leaves this process.
 */
export function hostFingerprint() {
  if (cached === undefined) {
    const id = machineIdentifier();
    cached = id
      ? createHash("sha256")
          .update(`agentpier-host\0${id.toLowerCase()}`)
          .digest("hex")
          .slice(0, 32)
      : null;
  }
  return cached;
}
