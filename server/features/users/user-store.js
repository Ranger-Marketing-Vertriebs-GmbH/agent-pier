import { randomUUID } from "node:crypto";
import path from "node:path";
import { readJSON, writePrivate } from "../../lib/storage.js";
import {
  dummyCredential,
  hashPassword,
  newSalt,
  validCredential,
  validPassword,
  validUsername,
  verifyPassword,
} from "../login/passwords.js";
import { SessionLedger, digest } from "../login/session-ledger.js";
import { AttemptWindows } from "../login/attempt-windows.js";
import { userProblem } from "./user-errors.js";

const normalised = (name) => name.trim().toLowerCase();
const validRecord = (user) =>
  typeof user?.id === "string" &&
  typeof user.username === "string" &&
  typeof user.displayName === "string" &&
  typeof user.disabled === "boolean" &&
  // A user restored without the backup's credentials has no password until a reset.
  (user.mustReset === true ? user.salt === undefined : validCredential(user));
const publicUser = ({ salt: _salt, hash: _hash, ...user }) =>
  structuredClone({ ...user, ownerMayRead: { ...user.ownerMayRead } });

// Restricted users and their sessions; never shares a file with the owner's login.
export class UserStore {
  constructor({ dataDir, now = Date.now, ownerName = () => null, hashPassword: hash }) {
    this.file = path.join(dataDir, "users", "users.json");
    this.now = now;
    this.ownerName = ownerName;
    this.hash = hash || hashPassword;
    this.data = readJSON(this.file, { version: 1, users: [], sessions: [] });
    // Corrupt private state must fail closed, like the owner's login.
    if (
      this.data?.version !== 1 ||
      !Array.isArray(this.data.users) ||
      !Array.isArray(this.data.sessions) ||
      !this.data.users.every(validRecord) ||
      !this.data.sessions.every((row) => typeof row?.userId === "string")
    )
      throw new Error("Invalid private user state");
    for (const user of this.data.users)
      user.ownerMayRead = {
        enabled: user.ownerMayRead?.enabled === true,
        since: user.ownerMayRead?.enabled === true ? user.ownerMayRead.since : null,
      };
    this.ledger = new SessionLedger({
      rows: this.data.sessions,
      save: () => this.save(),
      now: () => this.now(),
    });
    // Password changes check the current password like a sign-in and get the same limit.
    this.attempts = new AttemptWindows({ now: () => this.now() });
  }
  save() {
    writePrivate(this.file, this.data);
  }
  timestamp() {
    return new Date(this.now()).toISOString();
  }
  record(id) {
    const user = this.data.users.find((candidate) => candidate.id === id);
    if (!user) throw userProblem("USER_NOT_FOUND");
    return user;
  }
  list() {
    return this.data.users.map(publicUser);
  }
  get(id) {
    return publicUser(this.record(id));
  }
  taken(username) {
    const name = normalised(username);
    const owner = this.ownerName();
    return (
      (typeof owner === "string" && normalised(owner) === name) ||
      this.data.users.some((user) => normalised(user.username) === name)
    );
  }
  displayName(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    if (!validUsername(value)) throw userProblem("USER_DISPLAY_NAME_INVALID");
    return value.trim();
  }
  async credential(password) {
    if (!validPassword(password)) throw userProblem("LOGIN_PASSWORD_INVALID");
    const salt = newSalt();
    return { salt, hash: (await this.hash(password, salt)).toString("hex") };
  }
  async create({ username, displayName, password } = {}) {
    if (!validUsername(username)) throw userProblem("LOGIN_USERNAME_INVALID");
    const name = this.displayName(displayName, username.trim());
    if (this.taken(username)) throw userProblem("USER_NAME_TAKEN");
    const credential = await this.credential(password);
    // Hashing yields the event loop: check again so two creates never share a name.
    if (this.taken(username)) throw userProblem("USER_NAME_TAKEN");
    const now = this.timestamp();
    const user = {
      id: randomUUID(),
      username: username.trim(),
      displayName: name,
      ...credential,
      disabled: false,
      createdAt: now,
      passwordChangedAt: now,
      ownerMayRead: { enabled: false, since: null },
    };
    this.data.users.push(user);
    this.save();
    return publicUser(user);
  }
  update(id, { displayName, disabled } = {}) {
    const user = this.record(id);
    if (disabled !== undefined && typeof disabled !== "boolean")
      throw userProblem("USER_CHANGE_INVALID");
    const name =
      displayName === undefined ? user.displayName : this.displayName(displayName, null);
    if (name === null) throw userProblem("USER_DISPLAY_NAME_INVALID");
    user.displayName = name;
    if (disabled !== undefined) user.disabled = disabled;
    this.save();
    if (user.disabled) this.revokeUser(id);
    return publicUser(user);
  }
  async resetPassword(id, password) {
    this.record(id);
    const credential = await this.credential(password);
    const user = this.record(id);
    Object.assign(user, credential, { passwordChangedAt: this.timestamp() });
    delete user.mustReset;
    this.save();
    this.revokeUser(id);
  }
  async changePassword(id, { current, next } = {}, keepToken) {
    const user = this.record(id);
    if (!this.attempts.allow(id)) throw userProblem("LOGIN_THROTTLED");
    const checked = user.hash;
    if (
      !(await verifyPassword(current, user.mustReset ? dummyCredential : user, this.hash))
    )
      throw userProblem("USER_PASSWORD_WRONG");
    const credential = await this.credential(next);
    // An owner reset, another change or a revoked session during the hashes wins.
    if (typeof keepToken === "string" && !this.session(keepToken))
      throw userProblem("LOGIN_REQUIRED");
    if (this.data.users.find((candidate) => candidate.id === id)?.hash !== checked)
      throw userProblem("USER_PASSWORD_WRONG");
    Object.assign(user, credential, { passwordChangedAt: this.timestamp() });
    this.save();
    const keep = typeof keepToken === "string" ? digest(keepToken) : null;
    this.ledger.revokeWhere((row) => row.userId === id && row.hash !== keep);
  }
  setOwnerMayRead(id, enabled) {
    const user = this.record(id);
    // Switching it on again keeps the first `since`; a retry never hides chats.
    if ((user.ownerMayRead?.enabled === true) === enabled) return publicUser(user);
    user.ownerMayRead = enabled
      ? { enabled: true, since: this.timestamp() }
      : { enabled: false, since: null };
    this.save();
    return publicUser(user);
  }
  remove(id) {
    const index = this.data.users.findIndex((user) => user.id === id);
    if (index < 0) throw userProblem("USER_NOT_FOUND");
    this.data.users.splice(index, 1);
    this.save();
    this.revokeUser(id);
  }
  revokeUser(id) {
    this.ledger.revokeWhere((row) => row.userId === id);
  }
  /**
   * Login names compare case-sensitively after trimming, like the owner's login. A match
   * yields the credential it checked, so issue() can tell when it changed meanwhile.
   */
  async verify({ username, password } = {}) {
    const name = typeof username === "string" ? username.trim() : null;
    const found = this.data.users.find((candidate) => candidate.username === name);
    // A user without a password (restored without credentials) cannot sign in.
    const user = found?.mustReset ? undefined : found;
    const checked = user?.hash;
    const matches = await verifyPassword(password, user || dummyCredential, this.hash);
    return matches && user && !user.disabled ? { userId: user.id, hash: checked } : null;
  }
  // Hashing yields the event loop: a user deleted, disabled or given a new password
  // during her sign-in gets no session, the same answer as a wrong password.
  issue({ userId, hash } = {}) {
    const user = this.data.users.find((candidate) => candidate.id === userId);
    if (!user || user.disabled || user.mustReset || user.hash !== hash)
      throw userProblem("LOGIN_CREDENTIALS_INVALID");
    return this.ledger.issue({ userId });
  }
  session(token) {
    const row = this.ledger.find(token);
    if (!row) return null;
    const user = this.data.users.find((candidate) => candidate.id === row.userId);
    return user && !user.disabled ? row : null;
  }
  require(token) {
    const row = this.session(token);
    if (!row) throw userProblem("LOGIN_REQUIRED");
    this.ledger.touch(row);
    return row;
  }
  renew(row) {
    return this.ledger.renew(row);
  }
  revoke(token) {
    this.ledger.revoke(token);
  }
  watch(row, close) {
    return this.ledger.watch(row, close);
  }
}
