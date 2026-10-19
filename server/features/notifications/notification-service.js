import { serverMessages } from "../../lib/i18n/de.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import webpush from "web-push";
import { privateDatabase } from "../../lib/private-database.js";
import { problem, nameValue } from "../../lib/storage.js";
import { pushId, pushSubscription, pushEvent } from "./push-validation.js";
import { buildPayload, pushSource } from "./push-content.js";
import {
  defaultPreferences,
  normalizePreferences,
  systemKinds,
  updatePreferences,
  validTimeZone,
  wantsEvent,
} from "./push-preferences.js";
import { PushPresence } from "./push-presence.js";
import { createPushSender } from "./push-sender.js";
import { pushFailureText } from "./push-failure.js";

/** A lookup for a notice, given up (undefined) after a failure or the time limit. */
async function bounded(read, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export class NotificationService {
  constructor({ dataDir, send = createPushSender(), clock = Date, inboxCount = null }) {
    this.send = send;
    this.clock = clock;
    // The number of inbox items, for the app badge (set once the inbox exists).
    this.inboxCount = inboxCount;
    this.presence = new PushPresence({ now: () => this.clock.now() });
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
        .map((row) => this.summary(row.public)),
    };
  }
  /** A stored device summary, with its preferences in the current shape. */
  summary(text) {
    const summary = JSON.parse(text);
    return { ...summary, preferences: normalizePreferences(summary.preferences) };
  }
  async subscribe(input) {
    if (this.closed) throw problem(serverMessages.notifications.unavailable, 503);
    const deviceId = pushId(input?.deviceId),
      label = nameValue(input.label),
      subscription = pushSubscription(input.subscription);
    if (label.length > 80) throw problem(serverMessages.notifications.deviceLabelTooLong);
    const existing = this.db
      .prepare("SELECT id,public,secret FROM subscriptions WHERE device_id=?")
      .get(deviceId);
    if (!existing && this.status().subscriptions.length >= 50)
      throw problem(serverMessages.notifications.deviceLimit, 409);
    const previous = existing ? this.summary(existing.public) : null;
    const timeZone = validTimeZone(input.timeZone) ? input.timeZone : null;
    // A new device starts at the event type only; a renewed one keeps its choices.
    const preferences = previous ? previous.preferences : defaultPreferences(timeZone);
    if (timeZone) preferences.timeZone = timeZone;
    const summary = {
      id: existing?.id || randomUUID(),
      deviceId,
      label,
      createdAt: previous ? previous.createdAt : this.now(),
      preferences,
    };
    // Renaming keeps the delivery state of an unchanged push subscription.
    if (previous && existing.secret === JSON.stringify(subscription))
      for (const key of ["lastSuccessAt", "lastFailure"])
        if (previous[key] !== undefined) summary[key] = previous[key];
    this.db
      .prepare(
        "INSERT INTO subscriptions VALUES(?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET public=excluded.public,secret=excluded.secret",
      )
      .run(summary.id, deviceId, JSON.stringify(summary), JSON.stringify(subscription));
    return { subscription: summary };
  }
  /** Changes a device's preferences; unknown or invalid fields are refused. */
  async setPreferences(id, input) {
    if (this.closed) throw problem(serverMessages.notifications.unavailable, 503);
    const row = this.db
      .prepare("SELECT public FROM subscriptions WHERE id=?")
      .get(pushId(id));
    if (!row) throw problem(serverMessages.notifications.deviceNotRegistered, 404);
    const summary = this.summary(row.public);
    summary.preferences = updatePreferences(summary.preferences, input);
    this.db
      .prepare("UPDATE subscriptions SET public=? WHERE id=?")
      .run(JSON.stringify(summary), id);
    return { subscription: summary };
  }
  /** A visible page names its view (push-presence.js); false when rate limited. */
  reportPresence(route) {
    return this.presence.report(route);
  }
  badgeCount() {
    return this.inboxCount ? bounded(this.inboxCount, 1000) : undefined;
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
      return { sent: false, error: serverMessages.notifications.deviceNotRegistered };
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
            lastFailure: pushFailureText(error),
          };
          this.db
            .prepare("UPDATE subscriptions SET public=? WHERE id=?")
            .run(JSON.stringify(summary), id);
        }
      }
      return {
        sent: false,
        error: serverMessages.notifications.notDelivered,
      };
    }
  }
  track(promise) {
    this.active.add(promise);
    promise.finally(() => this.active.delete(promise)).catch(() => {});
    return promise;
  }
  async test(id) {
    if (this.closed) throw problem(serverMessages.notifications.unavailable, 503);
    const row = this.db
      .prepare("SELECT public FROM subscriptions WHERE id=?")
      .get(pushId(id));
    const preferences = row ? this.summary(row.public).preferences : defaultPreferences();
    const payload = buildPayload({ kind: "test", eventId: randomUUID() }, preferences, {
      count: await this.badgeCount(),
    });
    return this.track(this.deliver(id, payload));
  }
  async notify(input) {
    if (this.closed) return;
    // An emitter may pass the preview as a function: it is read only for devices
    // that show previews (a reply's start needs the session's chat).
    const lazy = typeof input?.preview === "function" ? input.preview : null;
    const event = pushEvent(lazy ? { ...input, preview: undefined } : input),
      now = this.clock.now(),
      targets = [];
    // Nobody needs a push about what an open AgentPier page shows right now.
    if (!systemKinds.has(event.kind) && this.presence.watching(event, pushSource(event)))
      return;
    const devices = this.status().subscriptions.filter((device) =>
      wantsEvent(device.preferences, event, now),
    );
    if (!devices.length) return;
    if (lazy && devices.some((device) => device.preferences.level === "preview")) {
      const preview = await bounded(lazy, 2000);
      if (typeof preview === "string" && preview.trim())
        event.preview = preview.slice(0, 4000);
    }
    const count = await this.badgeCount();
    if (this.closed) return;
    for (const { id, preferences } of devices) {
      const claim = this.db
        .prepare("INSERT OR IGNORE INTO deliveries VALUES(?,?,'claimed')")
        .run(event.eventId, id);
      if (claim.changes) targets.push([id, buildPayload(event, preferences, { count })]);
    }
    const work = (async () => {
      for (let index = 0; index < targets.length; index += 4)
        await Promise.all(
          targets.slice(index, index + 4).map(async ([id, payload]) => {
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
