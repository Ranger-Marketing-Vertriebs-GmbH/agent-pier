import { applyPreviewServe, removePreviewServe, serveView } from "./preview-serve.js";

const none = () => ({ registered: [], failed: [], commands: [] });

/**
 * The Tailscale Serve registrations of the preview range (preview-serve.js), kept for
 * the running process. `run` is the Tailscale CLI seam; without one nothing is called.
 */
export class PreviewRegistrations {
  constructor(run) {
    this.run = run;
    this.state = none();
  }

  /**
   * The update path of every start: in Tailscale mode register `range` (dropping owned
   * entries of `previousRange`); in any other mode remove AgentPier's own entries of
   * both, so a mode change never leaves them behind. Ownership checks keep it safe.
   */
  async sync({ tailscale, range, previousRange = null }) {
    this.state = none();
    if (!this.run) return;
    if (tailscale) {
      this.state = await applyPreviewServe({ run: this.run, range, previousRange });
      return;
    }
    for (const old of [previousRange, range])
      if (old) await removePreviewServe({ run: this.run, range: old });
  }

  /** Switching previews off removes AgentPier's own entries, whatever the mode. */
  async remove(range) {
    this.state = none();
    if (this.run) await removePreviewServe({ run: this.run, range });
  }

  has(slot) {
    return this.state.registered.includes(slot);
  }

  /** The slots of `range` Serve does not forward: never allocated in Tailscale mode. */
  unserved(range) {
    const slots = new Set();
    for (let slot = range.start; slot <= range.end; slot++)
      if (!this.has(slot)) slots.add(slot);
    return slots;
  }

  view(current) {
    return serveView(current, this.state);
  }
}
