import path from "node:path";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { loginProblem } from "./login-errors.js";
import {
  hashPassword,
  newSalt,
  validCredential,
  validPassword,
  validUsername,
  verifyPassword,
} from "./passwords.js";
import { AttemptWindows } from "./attempt-windows.js";
import { SessionLedger, absoluteDuration, idleDuration } from "./session-ledger.js";
export { absoluteDuration, idleDuration };
const day = 24 * 60 * 60 * 1000;
const legacyDuration = 7 * day;

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
          !validCredential(this.data.user)))
    )
      throw new Error("Invalid private login state");
    // Rows from the fixed seven-day lifetime carry only hash and expiry.
    for (const session of this.data.sessions) {
      if (!Number.isFinite(session.created))
        session.created = session.expires - legacyDuration;
      if (!Number.isFinite(session.lastUsed)) session.lastUsed = session.created;
    }
    this.ledger = new SessionLedger({
      rows: this.data.sessions,
      save: () => this.save(),
      now: () => this.now(),
    });
    // One attempt window per source (local, tailnet login or network address): a flood
    // from one device or tailnet member must not lock out the local owner.
    this.attempts = new AttemptWindows({ now: () => this.now() });
  }
  get configured() {
    return Boolean(this.data.user);
  }
  get watchers() {
    return this.ledger.watchers;
  }
  save() {
    writePrivate(this.file, this.data);
  }
  ownerName() {
    return this.data.user?.username ?? null;
  }
  async setup({ username, password } = {}, source) {
    if (this.configured) throw loginProblem("LOGIN_ALREADY_CONFIGURED");
    if (!validUsername(username)) throw loginProblem("LOGIN_USERNAME_INVALID");
    if (!validPassword(password)) throw loginProblem("LOGIN_PASSWORD_INVALID");
    this.throttle(source);
    const salt = newSalt();
    const hash = (await hashPassword(password, salt)).toString("hex");
    if (this.configured) throw loginProblem("LOGIN_ALREADY_CONFIGURED");
    this.data.user = { username: username.trim(), salt, hash };
    this.save();
    return this.issue();
  }
  throttle(source) {
    if (!this.attempts.allow(source)) throw loginProblem("LOGIN_THROTTLED");
  }
  // Checks the owner's credentials without throttling; callers throttle themselves.
  async verifyOwner({ username, password } = {}) {
    const user = this.data.user;
    if (!user || typeof username !== "string") return false;
    const matches = await verifyPassword(password, user);
    return matches && username.trim() === user.username;
  }
  async login(credentials = {}, source) {
    this.throttle(source);
    if (!(await this.verifyOwner(credentials)))
      throw loginProblem("LOGIN_CREDENTIALS_INVALID");
    return this.issue();
  }
  issue() {
    return this.ledger.issue();
  }
  session(token) {
    if (!this.configured) return null;
    return this.ledger.find(token);
  }
  require(token) {
    const session = this.session(token);
    if (!session) throw loginProblem("LOGIN_REQUIRED");
    this.ledger.touch(session);
    return session;
  }
  renew(session) {
    return this.ledger.renew(session);
  }
  revoke(token) {
    if (this.configured) this.ledger.revoke(token);
  }
  revokeHash(hash) {
    this.ledger.revokeHash(hash);
  }
  watch(session, close) {
    return this.ledger.watch(session, close);
  }
}
