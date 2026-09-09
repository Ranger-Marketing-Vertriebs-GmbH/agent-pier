import { problem } from "../../lib/storage.js";

const failureMessage =
  "Die Sitzung konnte nicht neu geladen werden. Die bisherige Unterhaltung bleibt für einen erneuten Versuch erhalten.";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const active = (state) => ["waiting", "reloading"].includes(state);

/** Durable intent; interrupted reloads are never automatically replayed. */
export class SessionReload {
  constructor({ services, pollMs = 1000, readinessMs = 15000 }) {
    this.services = services;
    this.queue = Promise.resolve();
    this.closed = false;
    this.pending = new Set();
    this.pollMs = pollMs;
    this.readinessMs = readinessMs;
  }
  serial(operation) {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
  async initialize() {
    for (const session of await this.services.sessions.list()) {
      if (session.reload?.state === "waiting") this.pending.add(session.id);
      if (session.reload?.state === "reloading")
        await this.save(session, { state: "failed", error: failureMessage });
    }
    if (this.pollMs) {
      this.timer = setInterval(() => this.poll().catch(() => {}), this.pollMs);
      this.timer.unref();
    }
  }
  async inspect(id) {
    const { sessions, bindings, activity } = this.services;
    const session = await sessions.get(id);
    const supported =
      ["codex", "claude", "opencode"].includes(session.tool) &&
      !session.purpose &&
      !session.pipeline &&
      !session.imported?.historyOnly;
    const recovery =
      ["failed", "reloading"].includes(session.reload?.state) &&
      (session.reload?.replacementStarted === true || session.status === "stopped");
    const native = supported ? await bindings.resolve(session) : null;
    const nativeId = (recovery ? session.reload.nativeId : null) || native?.id || null;
    return {
      session,
      value: {
        eligible: supported && !!nativeId,
        reason: !supported
          ? "unsupported-session"
          : !nativeId
            ? "native-session-unverified"
            : null,
        nativeId,
        activity: await activity.read(session),
        state: session.reload?.state || "idle",
        error: session.reload?.error || null,
        requestId: session.reload?.requestId || null,
      },
    };
  }
  async status(id) {
    return (await this.inspect(id)).value;
  }
  async save(session, patch) {
    const current = await this.services.sessions.get(session.id);
    session.reload = { ...current.reload, ...patch, updatedAt: new Date().toISOString() };
    await this.services.sessions.updateReload(session.id, session.reload);
  }
  request(id, body = {}) {
    return this.serial(async () => {
      if (this.closed) throw problem("Session reload is shutting down.", 503);
      if (
        !uuid.test(body.requestId || "") ||
        !["now", "when-idle"].includes(body.mode) ||
        (body.interrupt !== undefined && typeof body.interrupt !== "boolean")
      )
        throw problem("Invalid session reload request.");
      const { session, value } = await this.inspect(id);
      if (
        session.reload?.requestId === body.requestId ||
        session.reload?.previousRequestIds?.includes(body.requestId)
      )
        return value;
      if ((session.reload?.previousRequestIds?.length || 0) >= 1000)
        throw problem("The reload request limit for this session has been reached.", 409);
      if (active(value.state)) throw problem("A session reload is already pending.", 409);
      if (!value.eligible)
        throw problem("No verified native conversation is available for reload.", 409);
      if (
        body.mode === "now" &&
        session.status === "running" &&
        value.activity.state !== "idle" &&
        body.interrupt !== true
      )
        throw problem("Confirm interruption before reloading this session.", 409);
      // Resolve history, account, executable and model before recording any destructive intent.
      const plan = await this.services.prepareReload(session, value.nativeId);
      const previousRequestIds = [
        ...(session.reload?.previousRequestIds || []),
        ...(session.reload?.requestId ? [session.reload.requestId] : []),
      ];
      await this.save(session, {
        state:
          body.mode === "when-idle" &&
          session.status === "running" &&
          value.activity.state !== "idle"
            ? "waiting"
            : "reloading",
        replacementStarted: plan.recovery === true,
        requestId: body.requestId,
        previousRequestIds,
        nativeId: value.nativeId,
        mode: body.mode,
        interrupt: body.mode === "now" && body.interrupt === true,
        error: null,
      });
      if (session.reload.state === "waiting") this.pending.add(id);
      else await this.run(session, plan);
      return this.status(id);
    });
  }
  async run(session, plan) {
    this.pending.delete(session.id);
    try {
      await this.save(session, { state: "reloading", error: null });
      await this.services.restartReload(session, plan);
      await this.verifyRestart(session.id, plan.nativeId);
      await this.save(session, { state: "completed", error: null });
      this.services.activity.remove(session.id);
    } catch {
      await this.save(session, { state: "failed", error: failureMessage });
    }
  }
  async verifyRestart(id, nativeId) {
    const deadline = Date.now() + this.readinessMs;
    do {
      const current = await this.services.sessions.get(id);
      if (current.status !== "running") throw problem("The resumed CLI exited.", 409);
      const bound = await this.services.bindings.resolve(current);
      if (bound?.id === nativeId) return;
      if (bound?.id && bound.id !== nativeId)
        throw problem("The resumed CLI selected a different conversation.", 409);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    throw problem("The resumed conversation could not be verified.", 409);
  }
  poll() {
    return this.serial(async () => {
      if (this.closed) return;
      for (const id of [...this.pending]) {
        let session;
        try {
          session = await this.services.sessions.get(id);
        } catch (error) {
          if (error.status === 404) {
            this.pending.delete(id);
            continue;
          }
          throw error;
        }
        if (session.reload?.state !== "waiting") {
          this.pending.delete(id);
          continue;
        }
        const { value } = await this.inspect(session.id);
        if (session.status === "running" && value.activity.state !== "idle") continue;
        try {
          if (!value.eligible || value.nativeId !== session.reload.nativeId)
            throw problem("The native conversation changed while waiting.", 409);
          const plan = await this.services.prepareReload(session, value.nativeId);
          await this.run(session, plan);
        } catch {
          this.pending.delete(id);
          await this.save(session, { state: "failed", error: failureMessage });
        }
      }
    });
  }
  cancel(id) {
    return this.serial(async () => {
      this.pending.delete(id);
      const { session } = await this.inspect(id);
      if (session.reload?.state === "waiting")
        await this.save(session, { state: "idle", error: null });
      else if (session.reload?.state === "reloading")
        throw problem("The session is already restarting.", 409);
      return this.status(id);
    });
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.queue;
  }
}
