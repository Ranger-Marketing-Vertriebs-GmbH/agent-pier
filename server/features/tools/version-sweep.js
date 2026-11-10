import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { heldPaths, runningCommandLines } from "../../lib/process-commands.js";
import { logFailure } from "../mcp-packages/package-install-job.js";
import { craftHome } from "./craft-home.js";
import { pruneReaVersions } from "./rea-components.js";

// While an old version stays for a running process, the sweep looks again this often.
const retryMs = 5 * 60 * 1000;

/**
 * Craft Anything reads Ghidra's and the JDK's paths from its config.toml when it
 * starts, so a rewrite does not reach a running server: while any Craft Anything
 * server of this data dir runs (its environment names the config folder below
 * `<data>/craft-anything`), no old Ghidra or JDK version is removed.
 */
export const craftServersHoldGhidra = (dataDir) => {
  const marker = `CRAFT_ANYTHING_CONFIG_DIR=${craftHome(dataDir)}${path.sep}`;
  return (id, lines) =>
    (id === "rea-ghidra" || id === "rea-jdk") &&
    lines.some((line) => line.includes(marker));
};

/** The mark a removal leaves in a tool folder it kept for a running server. */
export const removedMark = ".removed";

/** Whether removed tool `tool` left its folder for a running server. */
const removed = (tool) => fs.existsSync(path.join(tool.directory, removedMark));

/**
 * Whether `tool` wants the shared Ghidra and JDK: only while installed, never on the
 * stale settings of a folder its removal left behind.
 */
export const wantsGhidraOf = (tool) =>
  !!tool.serverId() && !removed(tool) && tool.stored().components.ghidra;

/** A new install of `tool` takes its folder back from the deferred removal. */
export const clearRemovedMark = (tool) =>
  fs.rmSync(path.join(tool.directory, removedMark), { force: true });

/**
 * Removes the folder of removed tool `tool` (a CraftTool or ReaTool: its config,
 * home and settings) that its removal left for a running server (marked
 * `removedMark`), once no process names it. Returns whether it still stays. A tool
 * that is installed, busy or has an installer request pending keeps its folder.
 */
export async function removeToolFolder(tool, held) {
  if (tool.serverId() || tool.job || tool.claimed || tool.stored().requested)
    return false;
  if (!removed(tool)) return false;
  if (held([tool.directory])) return true;
  await fsp.rm(tool.directory, { recursive: true, force: true });
  return false;
}

/**
 * The deferred removal of a managed tool's old version folders below `root`: an
 * update or a removal keeps a version a running process uses (a session's idle MCP
 * server started before), and this sweep removes it once that process exited. It runs
 * at the server start, after every job and, while something stays, every few minutes.
 * `lingering` lists what stayed at the last run; `onChange()` follows a change of it.
 * It never runs while `busy()` (a job of either tool) and then looks again later.
 * `leftovers(held)` removes what else a removal left for a running server (the tool's
 * own folder) and returns whether something still stays.
 */
export class VersionSweep {
  constructor({
    root,
    ids,
    commandLines = runningCommandLines,
    onChange = null,
    also = null,
    busy = () => false,
    leftovers = async () => false,
  }) {
    Object.assign(this, { root, ids, commandLines, onChange, also, busy, leftovers });
    this.lingering = [];
    this.running = null;
    this.timer = null;
    this.closed = false;
  }
  /** A `held` test for one job or sweep (heldPaths: a snapshot per prune). */
  held() {
    return heldPaths(this.commandLines, { also: this.also });
  }
  /** Versions of `id` a running process still uses, oldest name first, no duplicates. */
  runningVersions(id) {
    const versions = this.lingering
      .filter((item) => item.id === id && item.running && item.version)
      .map((item) => item.version);
    return [...new Set(versions)].sort();
  }
  /** Sweeps once (a second call meanwhile shares the run); never rejects. */
  run() {
    if (this.closed) return Promise.resolve();
    this.running ??= this.sweep().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  async sweep() {
    clearTimeout(this.timer);
    this.timer = null;
    const before = JSON.stringify(this.lingering);
    let later = false;
    if (this.busy()) later = true;
    else
      try {
        const held = this.held();
        this.lingering = await pruneReaVersions(this.root, { ids: this.ids, held });
        later = await this.leftovers(held);
      } catch (error) {
        logFailure("remove old versions of a managed tool", error);
      }
    if ((later || this.lingering.length) && !this.closed) {
      this.timer = setTimeout(() => void this.run(), retryMs);
      this.timer.unref?.();
    }
    if (JSON.stringify(this.lingering) !== before) {
      try {
        this.onChange?.();
      } catch (error) {
        logFailure("announce a managed tool's state", error);
      }
    }
  }
  /** AgentPier stops: no further sweeps. */
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.running;
  }
}
