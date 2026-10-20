import { loginProblem } from "../login/login-errors.js";

/** The principal a session row stands for: the owner, or one restricted user. */
export const principalOf = (row) =>
  typeof row?.userId === "string"
    ? { role: "user", userId: row.userId }
    : { role: "owner" };

/**
 * One view over the owner's login and the users' sessions. The two stores keep separate
 * files, so an older release that reads only auth.json never sees a user session.
 */
export class Identity {
  constructor({ login, users }) {
    this.store = login;
    this.users = users;
  }
  get configured() {
    return this.store.configured;
  }
  get hasUsers() {
    return this.users.list().length > 0;
  }
  principal(row) {
    return principalOf(row);
  }
  setup(body, source) {
    // Names stay unique across the owner and every user, also after an owner reset.
    const username = body?.username;
    if (
      !this.store.configured &&
      typeof username === "string" &&
      this.users.taken(username)
    )
      throw loginProblem("LOGIN_USERNAME_TAKEN");
    return this.store.setup(body, source);
  }
  async login(body, source) {
    this.store.throttle(source);
    const { username, password } = body || {};
    if (typeof username !== "string" || typeof password !== "string")
      throw loginProblem("LOGIN_CREDENTIALS_INVALID");
    if (!this.store.configured) throw loginProblem("LOGIN_CREDENTIALS_INVALID");
    if (username.trim() === this.store.ownerName()) {
      if (await this.store.verifyOwner({ username, password })) return this.store.issue();
      throw loginProblem("LOGIN_CREDENTIALS_INVALID");
    }
    // Unknown names verify against a fixed record, so they cost the same as a user.
    const userId = await this.users.verify({ username, password });
    if (!userId) throw loginProblem("LOGIN_CREDENTIALS_INVALID");
    return this.users.issue(userId);
  }
  // Users exist only below a configured owner; without one nobody is signed in.
  session(token) {
    if (!this.store.configured) return null;
    return this.store.session(token) || this.users.session(token);
  }
  require(token) {
    if (this.store.configured && this.store.session(token))
      return this.store.require(token);
    if (!this.store.configured) throw loginProblem("LOGIN_REQUIRED");
    // Checks the user record on every call, so a disabled user is signed out at once.
    return this.users.require(token);
  }
  owner(row) {
    return typeof row?.userId === "string" ? this.users : this.store;
  }
  renew(row) {
    return this.owner(row).renew(row);
  }
  watch(row, close) {
    return this.owner(row).watch(row, close);
  }
  revoke(token) {
    this.store.revoke(token);
    this.users.revoke(token);
  }
  // What /auth/status reports about the signed-in principal.
  describe(token) {
    const row = this.session(token);
    if (!row) return { role: null, user: null };
    const principal = principalOf(row);
    if (principal.role === "owner") return { role: "owner", user: null };
    const { id, username, displayName } = this.users.get(principal.userId);
    return { role: "user", user: { id, username, displayName } };
  }
}
