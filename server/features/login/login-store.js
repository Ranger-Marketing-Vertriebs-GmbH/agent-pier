import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { loginProblem } from "./login-errors.js";
const derive = promisify(scrypt);
const digest = (token) => createHash("sha256").update(token).digest("hex");
const day = 24 * 60 * 60 * 1000;
// Sliding sessions: each renewal grants a fresh idle window, never beyond the absolute cap.
export const idleDuration = 30 * day;
export const absoluteDuration = 90 * day;
const legacyDuration = 7 * day;
// setTimeout overflows above 2^31-1 ms and would fire at once.
const maxTimer = 2 ** 31 - 1;
const hashPassword = (password, salt) =>
  derive(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 });

export class LoginStore {
  constructor({ dataDir, now = Date.now }) {
    this.file = path.join(dataDir, "login", "auth.json");
    this.now = now;
    this.data = readJSON(this.file, { user: null, sessions: [] });
    // Corrupt private state must fail closed, never silently reopen setup.
    if (
      !this.data ||
      !Array.isArray(this.data.sessions) ||
      (this.data.user !== null &&
        (typeof this.data.user?.username !== "string" ||
          !/^[a-f0-9]{64}$/.test(this.data.user?.salt) ||
          !/^[a-f0-9]{128}$/.test(this.data.user?.hash)))
    )
      throw new Error("Invalid private login state");
    // Rows from the fixed seven-day lifetime carry only hash and expiry.
    for (const session of this.data.sessions) {
      if (!Number.isFinite(session.created))
        session.created = session.expires - legacyDuration;
      if (!Number.isFinite(session.lastUsed)) session.lastUsed = session.created;
    }
    this.watchers = new Map();
    // One attempt window per source address: a LAN flood must not lock out the local owner.
    this.attempts = new Map();
  }
  get configured() {
    return Boolean(this.data.user);
  }
  save() {
    writePrivate(this.file, this.data);
  }
  async setup({ username, password } = {}, source) {
    if (this.configured) throw loginProblem("LOGIN_ALREADY_CONFIGURED");
    if (
      typeof username !== "string" ||
      !username.trim() ||
      username.trim().length > 100 ||
      /[\x00-\x1f\x7f]/.test(username)
    )
      throw loginProblem("LOGIN_USERNAME_INVALID");
    if (typeof password !== "string" || password.length < 12 || password.length > 1024)
      throw loginProblem("LOGIN_PASSWORD_INVALID");
    this.throttle(source);
    const salt = randomBytes(32).toString("hex");
    const hash = (await hashPassword(password, salt)).toString("hex");
    if (this.configured) throw loginProblem("LOGIN_ALREADY_CONFIGURED");
    this.data.user = { username: username.trim(), salt, hash };
    this.save();
    return this.issue();
  }
  throttle(source) {
    const key = String(source ?? "");
    const now = this.now();
    const window = this.attempts.get(key);
    if (window && now - window.start < 60000) {
      if (++window.count > 10) throw loginProblem("LOGIN_THROTTLED");
      return;
    }
    this.attempts.delete(key);
    // Bounded map: a flood of changing sources drops the oldest window instead of growing.
    while (this.attempts.size >= 1000)
      this.attempts.delete(this.attempts.keys().next().value);
    this.attempts.set(key, { start: now, count: 1 });
  }
  async login({ username, password } = {}, source) {
    this.throttle(source);
    const user = this.data.user;
    if (
      !user ||
      typeof username !== "string" ||
      typeof password !== "string" ||
      password.length > 1024
    )
      throw loginProblem("LOGIN_CREDENTIALS_INVALID");
    const hash = await hashPassword(password, user.salt);
    if (
      !timingSafeEqual(hash, Buffer.from(user.hash, "hex")) ||
      username.trim() !== user.username
    )
      throw loginProblem("LOGIN_CREDENTIALS_INVALID");
    return this.issue();
  }
  issue() {
    const token = randomBytes(32).toString("hex");
    this.data.sessions = this.data.sessions.filter(
      (session) => session.expires > this.now(),
    );
    while (this.data.sessions.length >= 20)
      this.revokeHash(
        this.data.sessions.reduce((oldest, session) =>
          session.lastUsed < oldest.lastUsed ? session : oldest,
        ).hash,
      );
    const now = this.now();
    this.data.sessions.push({
      hash: digest(token),
      created: now,
      lastUsed: now,
      expires: now + idleDuration,
    });
    this.save();
    return token;
  }
  session(token) {
    if (!this.configured || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
      return null;
    return (
      this.data.sessions.find(
        (session) => session.hash === digest(token) && session.expires > this.now(),
      ) || null
    );
  }
  require(token) {
    const session = this.session(token);
    if (!session) throw loginProblem("LOGIN_REQUIRED");
    // In memory only; renewals and later writes persist it for eviction order.
    session.lastUsed = this.now();
    return session;
  }
  // Returns the new cookie lifetime when the expiry moved, otherwise null. Writes happen only
  // once less than half the idle window remains, so at most about every fifteen days.
  renew(session) {
    const now = this.now();
    if (session.expires - now >= idleDuration / 2) return null;
    const expires = Math.min(now + idleDuration, session.created + absoluteDuration);
    if (expires <= session.expires) return null;
    session.expires = expires;
    this.save();
    for (const watcher of this.watchers.get(session.hash) || []) watcher.schedule();
    return expires - now;
  }
  revoke(token) {
    const session = this.session(token);
    if (session) {
      this.revokeHash(session.hash);
      this.save();
    }
  }
  revokeHash(hash) {
    this.data.sessions = this.data.sessions.filter((session) => session.hash !== hash);
    for (const watcher of this.watchers.get(hash) || []) {
      clearTimeout(watcher.timer);
      watcher.close();
    }
    this.watchers.delete(hash);
  }
  watch(session, close) {
    const watcher = { close, timer: null };
    // Renewals reschedule; a long wait re-arms in chunks and rechecks the current expiry.
    watcher.schedule = () => {
      clearTimeout(watcher.timer);
      const remaining = session.expires - this.now();
      watcher.timer = setTimeout(
        () => (session.expires > this.now() ? watcher.schedule() : close()),
        Math.min(maxTimer, Math.max(0, remaining)),
      );
      watcher.timer.unref?.();
    };
    watcher.schedule();
    const watchers = this.watchers.get(session.hash) || new Set();
    watchers.add(watcher);
    this.watchers.set(session.hash, watchers);
    return () => {
      clearTimeout(watcher.timer);
      watchers.delete(watcher);
      if (!watchers.size) this.watchers.delete(session.hash);
    };
  }
}
