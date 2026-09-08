import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { readJSON, writePrivate, problem } from "../../lib/storage.js";
import { loginMessages as copy } from "../../lib/i18n/de/login.js";
const derive = promisify(scrypt);
const digest = (token) => createHash("sha256").update(token).digest("hex");
export const sessionDuration = 7 * 24 * 60 * 60 * 1000;
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
    this.watchers = new Map();
    this.attempts = 0;
    this.windowStart = now();
  }
  get configured() {
    return Boolean(this.data.user);
  }
  save() {
    writePrivate(this.file, this.data);
  }
  async setup({ username, password } = {}) {
    if (this.configured) throw problem(copy.exists, 409);
    if (
      typeof username !== "string" ||
      !username.trim() ||
      username.trim().length > 100 ||
      /[\x00-\x1f\x7f]/.test(username)
    )
      throw problem(copy.username);
    if (typeof password !== "string" || password.length < 12 || password.length > 1024)
      throw problem(copy.password);
    this.throttle();
    const salt = randomBytes(32).toString("hex");
    const hash = (await hashPassword(password, salt)).toString("hex");
    if (this.configured) throw problem(copy.exists, 409);
    this.data.user = { username: username.trim(), salt, hash };
    this.save();
    return this.issue();
  }
  throttle() {
    if (this.now() - this.windowStart >= 60000) {
      this.windowStart = this.now();
      this.attempts = 0;
    }
    if (++this.attempts > 10) throw problem(copy.throttled, 429);
  }
  async login({ username, password } = {}) {
    this.throttle();
    const user = this.data.user;
    if (
      !user ||
      typeof username !== "string" ||
      typeof password !== "string" ||
      password.length > 1024
    )
      throw problem(copy.invalid, 401);
    const hash = await hashPassword(password, user.salt);
    if (
      !timingSafeEqual(hash, Buffer.from(user.hash, "hex")) ||
      username.trim() !== user.username
    )
      throw problem(copy.invalid, 401);
    return this.issue();
  }
  issue() {
    const token = randomBytes(32).toString("hex");
    this.data.sessions = this.data.sessions.filter(
      (session) => session.expires > this.now(),
    );
    while (this.data.sessions.length >= 20) this.revokeHash(this.data.sessions[0].hash);
    this.data.sessions.push({
      hash: digest(token),
      expires: this.now() + sessionDuration,
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
    if (!session) throw problem(copy.required, 401);
    return session;
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
    for (const close of this.watchers.get(hash) || []) close();
    this.watchers.delete(hash);
  }
  watch(session, close) {
    const timer = setTimeout(close, Math.max(0, session.expires - this.now()));
    timer.unref();
    const callbacks = this.watchers.get(session.hash) || new Set();
    callbacks.add(close);
    this.watchers.set(session.hash, callbacks);
    return () => {
      clearTimeout(timer);
      callbacks.delete(close);
      if (!callbacks.size) this.watchers.delete(session.hash);
    };
  }
}
