import { heldPaths, runningCommandLines } from "../../lib/process-commands.js";
import { logFailure } from "../mcp-packages/package-install-job.js";
import { pruneReaVersions } from "./rea-components.js";

// While an old version stays for a running process, the sweep looks again this often.
const retryMs = 5 * 60 * 1000;

/**
 * The deferred removal of a managed tool's old version folders below `root`: an
 * update or a removal keeps a version a running process uses (a session's idle MCP
 * server started before), and this sweep removes it once that process exited. It runs
 * at the server start, after every job and, while something stays, every few minutes.
 * `lingering` lists what stayed at the last run; `onChange()` follows a change of it.
 */
export class VersionSweep {
  constructor({ root, ids, commandLines = runningCommandLines, onChange = null }) {
    Object.assign(this, { root, ids, commandLines, onChange });
    this.lingering = [];
    this.running = null;
    this.timer = null;
    this.closed = false;
  }
  /** A fresh `held` test for one job or sweep (the process list is read once). */
  held() {
    return heldPaths(this.commandLines);
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
    try {
      this.lingering = await pruneReaVersions(this.root, {
        ids: this.ids,
        held: this.held(),
      });
    } catch (error) {
      logFailure("remove old versions of a managed tool", error);
    }
    if (this.lingering.length && !this.closed) {
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
