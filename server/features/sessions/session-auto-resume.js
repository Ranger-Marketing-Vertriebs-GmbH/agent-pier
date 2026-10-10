import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const IN_PROGRESS = ["waiting", "reloading"];

/** Resumes sessions whose tmux server was lost: oldest first, one at a time, once each. */
export class SessionAutoResume {
  constructor({ services, enabled = () => true, timeoutMs = 120_000, pollMs = 1000 }) {
    this.services = services;
    this.enabled = enabled;
    this.timeoutMs = timeoutMs;
    this.pollMs = pollMs;
    this.queue = Promise.resolve();
    this.closed = false;
  }
  initialize() {
    this.enqueue(() => this.sweep());
    return this.notify();
  }
  notify() {
    return this.enqueue(() => this.drain());
  }
  enqueue(task) {
    const next = this.queue.then(task);
    this.queue = next.catch(() => {});
    return next;
  }
  async sweep() {
    // An attempt that a restart cut off is not repeated; a crashing CLI must not loop.
    for (const session of await this.services.sessions.list())
      if (session.interruption?.resume === "started")
        await this.finish(session, "failure", {
          ...session.interruption,
          resume: "failed",
          reason: "attempt-interrupted",
        });
  }
  async drain() {
    if (this.closed || !this.enabled()) return;
    const pending = (await this.services.sessions.list())
      .filter((s) => s.status === "stopped" && s.interruption?.resume === "pending")
      .sort((a, b) => a.interruption.at.localeCompare(b.interruption.at));
    for (const { id } of pending) {
      if (this.closed || !this.enabled()) return;
      try {
        await this.resume(id);
      } catch (error) {
        console.error(
          `AgentPier could not resume a session: ${error?.code || error?.message || "unknown error"}`,
        );
      }
    }
  }
  async resume(id) {
    const { sessions, reload } = this.services;
    let session;
    try {
      session = await sessions.get(id);
    } catch (error) {
      if (error.status === 404) return;
      throw error;
    }
    if (session.status !== "stopped" || session.interruption?.resume !== "pending")
      return;
    const interruption = { ...session.interruption, resume: "started" };
    await sessions.setInterruption(id, interruption);
    const failed = (reason, resume = "failed") =>
      this.finish(session, "failure", { ...interruption, resume, reason });
    let result;
    try {
      const status = await reload.status(id);
      if (!status.eligible)
        return await failed(status.reason || "unsupported-session", "skipped");
      result = await reload.request(id, { requestId: randomUUID(), mode: "now" });
      const deadline = Date.now() + this.timeoutMs;
      while (
        IN_PROGRESS.includes(result.state) &&
        Date.now() < deadline &&
        !this.closed
      ) {
        await delay(this.pollMs);
        result = await reload.status(id);
      }
    } catch {
      return failed("prepare-failed");
    }
    // A completed replacement already removed the marker.
    if (result.state === "completed") return this.finish(session, "success", null);
    return failed(result.state === "failed" ? "reload-failed" : "timeout");
  }
  async finish(session, outcome, interruption) {
    try {
      if (interruption && (await this.isCurrent(session)))
        await this.services.sessions.setInterruption(session.id, interruption);
    } catch {
      /* The session may be gone; the audit entry below still records the outcome. */
    }
    try {
      this.services.audit?.append({
        action: "session.restored",
        resourceType: "session",
        resourceId: session.id,
        sessionId: session.id,
        source: "system",
        outcome,
        details: { tool: session.tool },
      });
    } catch {
      /* The audit trail is supplemental; the session marker stays authoritative. */
    }
  }
  // Only the attempt's own "started" marker may be replaced; newer state wins.
  async isCurrent(session) {
    try {
      const stored = (await this.services.sessions.get(session.id)).interruption;
      return stored?.resume === "started" && stored.at === session.interruption.at;
    } catch (error) {
      if (error.status === 404) return false;
      throw error;
    }
  }
  async close() {
    this.closed = true;
    await this.queue;
  }
}
