import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { processOptions } from "./ssh-keys.js";
import { reportsHostKeyChange, withTestOutcome } from "./ssh-test-results.js";

/** How long a console test waits for the device's first prompt. */
export const consoleTestTimeoutMs = 20000;

/**
 * Test connection of an SSH host (docs/ssh-access.md): it checks that AgentPier can
 * sign in, not that the device knows a command. OpenSSH exits with 255 for its own
 * errors (network, host key, authentication); any other exit status of the test
 * command `true` means the sign-in worked, and `commandRejected` notes that the
 * device (for example RouterOS) did not run it. A host in interactive shell mode
 * passes once its console showed a prompt; the test then logs out. A failure carries
 * `testOutcome` (OpenSSH's stderr for the stored, sanitized result); the answer itself
 * names no output.
 */
export async function testConnection(store, id) {
  const connection = store.connection(id);
  try {
    if (connection.interactive) {
      const result = await store.runConsole(connection, "", {
        timeoutMs: consoleTestTimeoutMs,
      });
      if (!result.started) throw Object.assign(Error("no prompt"), result);
      return { ok: true, interactive: true };
    }
    try {
      await store.run(connection.command, [...connection.args, "true"], {
        ...processOptions,
        cwd: connection.cwd,
      });
      return { ok: true };
    } catch (error) {
      if (Number.isInteger(error?.code) && error.code !== 255 && !error.killed)
        return { ok: true, commandRejected: true };
      throw error;
    }
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    throw withTestOutcome(problem(serverMessages.ssh.connectionFailed, 502), {
      hostKeyMismatch: reportsHostKeyChange(stderr),
      detail: stderr,
    });
  } finally {
    connection.cleanup();
  }
}
