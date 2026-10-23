import { patchConfig } from "./openclaw-config/live-patch.js";
import {
  browserProfilesPatch,
  nextBrowserProfiles,
} from "./openclaw-config/browser-profiles.js";

/**
 * Keeps the running Gateway's `browser.profiles` in step with the agents: the start
 * compiles the browser block whenever a browser is available (web-tools.js), so an
 * agent switching its browser or its visible window on or off only adds, changes or
 * removes its own profile, which OpenClaw 2026.10.3 hot-applies
 * (docs/assistant-web-tools-qualification.md). The supervisor's start snapshot
 * (`runtime.webTools.browserProfiles`) follows each applied patch.
 */
export class BrowserProfileSync {
  // `stop(name)` ends a running browser whose profile changed (agent-browsers.js).
  constructor({ runtime, store, stop = async () => {} }) {
    Object.assign(this, { runtime, store, stop });
  }
  /**
   * Applies the profiles the agents need now; resolves the names that changed. One at
   * a time: each sync reads the snapshot the previous one wrote, so two applies never
   * hand out the same CDP port.
   */
  sync() {
    const run = (this.queue || Promise.resolve())
      .catch(() => {})
      .then(() => this.syncOnce());
    this.queue = run;
    return run;
  }
  async syncOnce() {
    const running = this.runtime.client?.ready && this.runtime.webTools;
    if (!running?.availability?.browser) return [];
    const current = running.browserProfiles || {};
    const next = nextBrowserProfiles({
      current,
      profiles: this.store.listAssistants(),
      visibleApp: running.visibleBrowser === true,
      port: running.port,
    });
    const patch = browserProfilesPatch(current, next);
    if (!patch) return [];
    // A browser whose profile goes or changes its window mode stops first; it starts
    // again with the new profile on its next use.
    const changed = Object.keys(patch).filter((name) => name in current);
    for (const name of changed) await this.stop(name);
    await patchConfig(this.runtime.client, () => ({
      patch: { browser: { profiles: patch } },
    }));
    if (this.runtime.webTools === running) running.browserProfiles = next;
    return Object.keys(patch);
  }
}
