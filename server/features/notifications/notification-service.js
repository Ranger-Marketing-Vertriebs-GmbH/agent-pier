import path from "node:path";
import { randomUUID } from "node:crypto";
import webpush from "web-push";
import { privateDatabase } from "../../lib/private-database.js";
import { problem, nameValue } from "../../lib/storage.js";
import { pushId, pushSubscription, pushPayload } from "./push-validation.js";
import { createPushSender } from "./push-sender.js";

export class NotificationService {
  constructor({ dataDir, send = createPushSender(), clock = Date }) {
    this.send = send;
    this.clock = clock;
    this.active = new Set();
    this.inFlight = 0;
    this.queue = [];
    this.db = privateDatabase(
      path.join(dataDir, "notifications"),
      "notifications.sqlite",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY,device_id TEXT NOT NULL UNIQUE,public TEXT NOT NULL,secret TEXT NOT NULL); CREATE TABLE IF NOT EXISTS deliveries (event_id TEXT NOT NULL,subscription_id TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(event_id,subscription_id)); CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY,value TEXT NOT NULL); PRAGMA user_version=1;",
    );
    const existing = this.db
      .prepare("SELECT value FROM settings WHERE key='vapid'")
      .get();
    this.vapid = existing ? JSON.parse(existing.value) : webpush.generateVAPIDKeys();
    if (!existing)
      this.db
        .prepare("INSERT INTO settings VALUES('vapid',?)")
        .run(JSON.stringify(this.vapid));
  }
  now() {
    return new Date(this.clock.now()).toISOString();
  }
  status() {
    return {
      enabled: true,
      publicKey: this.vapid.publicKey,
      subscriptions: this.db
        .prepare("SELECT public FROM subscriptions ORDER BY rowid")
        .all()
        .map((row) => JSON.parse(row.public)),
    };
  }
  async subscribe(input) {
    if (this.closed) throw problem("Notifications are unavailable.", 503);
    const deviceId = pushId(input?.deviceId),
      label = nameValue(input.label),
      subscription = pushSubscription(input.subscription);
    if (label.length > 80)
      throw problem("Notification device labels are limited to 80 characters.");
    const existing = this.db
      .prepare("SELECT id,public FROM subscriptions WHERE device_id=?")
      .get(deviceId);
    if (!existing && this.status().subscriptions.length >= 50)
      throw problem("Remove an old notification device first.", 409);
    const summary = {
      id: existing?.id || randomUUID(),
      deviceId,
      label,
      createdAt: existing ? JSON.parse(existing.public).createdAt : this.now(),
    };
    this.db
      .prepare(
        "INSERT INTO subscriptions VALUES(?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET public=excluded.public,secret=excluded.secret",
      )
      .run(summary.id, deviceId, JSON.stringify(summary), JSON.stringify(subscription));
    return { subscription: summary };
  }
  async unsubscribe(id) {
    this.db.prepare("DELETE FROM subscriptions WHERE id=?").run(pushId(id));
    return { removed: true };
  }
  async deliver(id, payload) {
    if (this.closed) return { sent: false };
    if (this.inFlight >= 4) await new Promise((resolve) => this.queue.push(resolve));
    else this.inFlight++;
    try {
      if (this.closed) return { sent: false };
      return await this.deliverNow(id, payload);
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.inFlight--;
    }
  }
  async deliverNow(id, payload) {
    const row = this.db
      .prepare("SELECT public,secret FROM subscriptions WHERE id=?")
      .get(id);
    if (!row)
      return { sent: false, error: "Notification device is no longer registered." };
    try {
      await this.send(JSON.parse(row.secret), payload, this.vapid);
      const current = this.db
        .prepare("SELECT public FROM subscriptions WHERE id=? AND secret=?")
        .get(id, row.secret);
      if (current) {
        const summary = JSON.parse(current.public);
        summary.lastSuccessAt = this.now();
        delete summary.lastFailure;
        this.db
          .prepare("UPDATE subscriptions SET public=? WHERE id=?")
          .run(JSON.stringify(summary), id);
      }
      return { sent: true };
    } catch (error) {
      if ([404, 410].includes(error.statusCode))
        this.db
          .prepare("DELETE FROM subscriptions WHERE id=? AND secret=?")
          .run(id, row.secret);
      else {
        const current = this.db
          .prepare("SELECT public FROM subscriptions WHERE id=? AND secret=?")
          .get(id, row.secret);
        if (current) {
          const summary = {
            ...JSON.parse(current.public),
            lastFailure: "Delivery failed. Try a test notification.",
          };
          this.db
            .prepare("UPDATE subscriptions SET public=? WHERE id=?")
            .run(JSON.stringify(summary), id);
        }
      }
      return {
        sent: false,
        error:
          "Notification could not be delivered. Check this device's permission and subscription.",
      };
    }
  }
  track(promise) {
    this.active.add(promise);
    promise.finally(() => this.active.delete(promise)).catch(() => {});
    return promise;
  }
  async test(id) {
    if (this.closed) throw problem("Notifications are unavailable.", 503);
    return this.track(this.deliver(pushId(id), { kind: "test", eventId: randomUUID() }));
  }
  async notify(input) {
    if (this.closed) return;
    const payload = pushPayload(input),
      ids = [];
    for (const { id } of this.status().subscriptions) {
      const claim = this.db
        .prepare("INSERT OR IGNORE INTO deliveries VALUES(?,?,'claimed')")
        .run(payload.eventId, id);
      if (claim.changes) ids.push(id);
    }
    const work = (async () => {
      for (let index = 0; index < ids.length; index += 4)
        await Promise.all(
          ids.slice(index, index + 4).map(async (id) => {
            const result = await this.deliver(id, payload);
            this.db
              .prepare(
                "UPDATE deliveries SET status=? WHERE event_id=? AND subscription_id=?",
              )
              .run(result.sent ? "sent" : "failed", payload.eventId, id);
          }),
        );
    })();
    return this.track(work);
  }
  observation(id) {
    return this.db.prepare("SELECT value FROM observations WHERE id=?").get(id)?.value;
  }
  observe(id, value) {
    const previous = this.db
      .prepare("SELECT value FROM observations WHERE id=?")
      .get(id)?.value;
    this.db
      .prepare(
        "INSERT INTO observations VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(id, value);
    return previous === undefined ? null : previous !== value;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.send.close?.();
    await Promise.allSettled([...this.active]);
    this.db.close();
  }
}
