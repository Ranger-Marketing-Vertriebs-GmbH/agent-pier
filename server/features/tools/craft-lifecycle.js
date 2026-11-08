import fsp from "node:fs/promises";
import { serverMessages } from "../../lib/i18n/de.js";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { record } from "../extensions/mcp-config.js";
import { logFailure } from "../mcp-packages/package-install-job.js";
import { removeReaComponent, sweepReaComponents } from "./rea-components.js";
import { failureText } from "./rea-state.js";

const messages = serverMessages.craft;

/**
 * Removes Craft Anything (`craft` is a CraftTool): its row, its skill copies, the CLI
 * and `<data>/craft-anything`, plus Ghidra and the JDK unless the other tool keeps
 * them. Works whatever is left; refused while Craft Anything is in use.
 */
export async function uninstallCraft(craft, { source = "user" } = {}) {
  craft.requireIdle();
  await craft.requireUnused(!!craft.serverId());
  let done;
  craft.job = new Promise((resolve) => (done = resolve));
  craft.jobCount += 1;
  craft.status = "running";
  craft.message = "";
  try {
    const id = craft.serverId();
    craft.progress("core", messages.removing("Craft Anything"));
    if (id) {
      await craft.changes.remove(id);
      craft.auditRow("mcp.deleted", id, source);
    }
    await craft.syncSkills(null);
    await removeReaComponent(craft.root, "craft-anything");
    if (!craft.keepsGhidra()) {
      craft.progress("ghidra", messages.removing("Ghidra"));
      await removeReaComponent(craft.root, "rea-ghidra");
      await removeReaComponent(craft.root, "rea-jdk");
    }
    await fsp.rm(craft.directory, { recursive: true, force: true });
    craft.status = "idle";
    craft.message = "";
  } catch (error) {
    craft.status = "failed";
    craft.message = failureText(error, messages.failed);
    throw error;
  } finally {
    craft.job = null;
    craft.step = null;
    craft.changed();
    done();
  }
  return craft.state();
}

/** Drops the installer's request from the settings file, keeping everything else. */
function clearRequest(craft) {
  const saved = readJSON(craft.file, null);
  if (!record(saved) || !Object.hasOwn(saved, "requested")) return;
  const { requested: _done, ...rest } = saved;
  writePrivate(craft.file, rest);
}

/**
 * The install the installer requested. The request stays until the job settled with
 * success or a real failure, so a stop during the download retries it at next start.
 */
async function installRequested(craft, requested) {
  if (craft.serverId() || !craft.host().available) return clearRequest(craft);
  const components = {
    ghidra: requested.components?.ghidra === true && !!craft.reaHost().ghidra,
  };
  try {
    await craft.apply(
      { components, settings: requested.settings, confirmInstall: true },
      { source: "system" },
    );
  } catch (error) {
    // Refused before it ran (invalid settings, say): retrying would only refuse again.
    if (error?.status !== 409 || error.message !== messages.busy) clearRequest(craft);
    throw error;
  }
  await craft.settled();
  if (!craft.aborted) clearRequest(craft);
}

/**
 * At a server start (`craft` is a CraftTool): sweeps interrupted installs while no job
 * runs, installs what the installer requested, brings an outdated install to the pins
 * unless it is in use, rewrites the config and the row (command, args, env) and syncs
 * the skill copies. Never throws.
 */
export async function startCraft(craft) {
  try {
    if (!craft.job && !craft.claimed) sweepReaComponents(craft.root);
    const { requested } = craft.stored();
    if (requested) await installRequested(craft, requested);
    else if (craft.installed() && craft.outdated() && !(await craft.inUse())) {
      await craft.update({ source: "system" });
      await craft.settled();
    }
    await craft.syncEnvironment();
  } catch (error) {
    logFailure("start Craft Anything", error);
  }
  await craft.bindingsChanged();
}
