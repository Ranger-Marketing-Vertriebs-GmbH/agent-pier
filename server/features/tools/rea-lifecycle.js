import fsp from "node:fs/promises";
import { serverMessages } from "../../lib/i18n/de.js";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { record } from "../extensions/mcp-config.js";
import { logFailure } from "../mcp-packages/package-install-job.js";
import { removeReaComponent, sweepReaComponents } from "./rea-components.js";
import { failureText } from "./rea-state.js";

const messages = serverMessages.rea;

/**
 * Removes REA (`rea` is a ReaTool): its row (and with it the package's skill copies),
 * Ghidra, the JDK and `<data>/rea`. Works whatever is left, so a managed row of a
 * failed install or a restored backup goes too; refused while REA is in use.
 */
export async function uninstallRea(rea, { source = "user" } = {}) {
  rea.requireIdle();
  await rea.requireUnused(!!rea.serverId());
  let done;
  rea.job = new Promise((resolve) => (done = resolve));
  rea.status = "running";
  rea.message = "";
  try {
    const id = rea.serverId();
    rea.progress("core", messages.removing("REA Core"));
    if (id) {
      await rea.changes.remove(id);
      Promise.resolve(rea.packages.cancel(id)).catch(() => {});
      rea.packages.prune();
      rea.auditRow("mcp.deleted", id, source);
    }
    rea.progress("ghidra", messages.removing("Ghidra"));
    await removeReaComponent(rea.root, "rea-ghidra");
    await removeReaComponent(rea.root, "rea-jdk");
    await fsp.rm(rea.directory, { recursive: true, force: true });
    rea.status = "idle";
    rea.message = "";
  } catch (error) {
    rea.status = "failed";
    rea.message = failureText(error);
    throw error;
  } finally {
    rea.job = null;
    rea.step = null;
    done();
  }
  return rea.state();
}

/** Drops the installer's request from the settings file, keeping everything else. */
function clearRequest(rea) {
  const saved = readJSON(rea.file, null);
  if (!record(saved) || !Object.hasOwn(saved, "requested")) return;
  const { requested: _done, ...rest } = saved;
  writePrivate(rea.file, rest);
}

/**
 * The install the installer requested (--with-rea). The request stays until the job
 * settled with success or a real failure (shown on the card), so an AgentPier stop or
 * a crash during the long download retries it at the next start.
 */
async function installRequested(rea, requested) {
  const host = rea.host();
  if (rea.serverId() || !host.available) return clearRequest(rea);
  const components = {
    ghidra: requested.components?.ghidra === true && !!host.ghidra,
    frida: requested.components?.frida === true && !!host.frida,
  };
  try {
    await rea.apply(
      { components, settings: requested.settings, confirmInstall: true },
      { source: "system" },
    );
  } catch (error) {
    // Refused before it ran (invalid settings, say): retrying would only refuse again.
    if (error?.status !== 409 || error.message !== messages.busy) clearRequest(rea);
    throw error;
  }
  await rea.settled();
  if (!rea.aborted) clearRequest(rea);
}

/**
 * At a server start (`rea` is a ReaTool): sweeps interrupted installs while no REA job
 * runs or is being claimed, installs what the installer requested, brings an outdated
 * REA to the pins unless it is in use (then the next start tries again) and syncs the
 * skill copies. Never throws.
 */
export async function startRea(rea) {
  try {
    if (!rea.job && !rea.claimed) sweepReaComponents(rea.root);
    const { requested } = rea.stored();
    if (requested) await installRequested(rea, requested);
    else if (rea.installed() && rea.outdated() && !(await rea.inUse())) {
      await rea.update({ source: "system" });
      await rea.settled();
    }
  } catch (error) {
    logFailure("start REA", error);
  }
  await rea.bindingsChanged();
}
