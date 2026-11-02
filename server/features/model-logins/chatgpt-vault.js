import path from "node:path";
import { createHash } from "node:crypto";
import { privateDirectory, readJSON, writePrivate } from "../../lib/storage.js";
import { ChatGptAuth, authFailure } from "./chatgpt-auth.js";

// AgentPier's ChatGPT logins: the only copy of each account's refresh token, and the
// only process that redeems it (OpenAI rotates refresh tokens; a second refresher
// signs both out with `refresh_token_reused`). The runtimes get access tokens only:
// OpenClaw an access-only OAuth profile (runtimes/openclaw/openclaw-access-profiles.js),
// Hermes the loopback model proxy (runtime-proxy.js).

// Refreshed 30 minutes before expiry, or at half the lifetime when that comes first;
// a token used within 10 minutes of its expiry is refreshed first: OpenClaw stops
// using a profile within 5 minutes of its expiry (credential-state
// DEFAULT_OAUTH_REFRESH_MARGIN_MS).
const earlyMs = 30 * 60_000;
const latestMs = 10 * 60_000;
const retryMs = 60_000;
// setTimeout's limit; a later refresh is rescheduled when the timer fires.
const maxTimerMs = 2 ** 31 - 1;

const text = (value, max = 200) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

/** The OpenClaw profile id of a new login: `openai:<email>`, as OpenClaw names its own. */
export function chatgptProfileId({ email, accountId }) {
  if (email && /^[^\s@:]{1,100}@[^\s@:]{1,100}$/.test(email)) return `openai:${email}`;
  const digest = createHash("sha256")
    .update(String(accountId || ""))
    .digest("hex");
  return `openai:agentpier-${digest.slice(0, 16)}`;
}

/** When a token of `expires`, issued at `issued`, is refreshed. */
export function refreshAt({ issued, expires }) {
  return Math.min(expires - earlyMs, issued + (expires - issued) / 2);
}

export class ChatGptVault {
  #inflight = new Map();
  #timers = new Map();
  #listeners = new Set();
  constructor({
    dataDir,
    auth = new ChatGptAuth(),
    now = Date.now,
    warn = console.warn,
    schedule = true,
  }) {
    Object.assign(this, { auth, now, warn, schedule });
    this.file = path.join(dataDir, "model-logins", "chatgpt.json");
    const saved = readJSON(this.file, { logins: [] });
    this.records = new Map(
      (Array.isArray(saved?.logins) ? saved.logins : [])
        .filter(
          (r) => typeof r?.profileId === "string" && r.profileId.startsWith("openai:"),
        )
        .map((r) => [r.profileId, r]),
    );
    for (const profileId of this.records.keys()) this.#plan(profileId);
  }
  #persist() {
    privateDirectory(path.dirname(this.file));
    writePrivate(this.file, { version: 1, logins: [...this.records.values()] });
  }
  /** `listener(profileId)` after every saved change of a login. */
  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #changed(profileId) {
    for (const listener of this.#listeners)
      Promise.resolve()
        .then(() => listener(profileId))
        .catch(() =>
          this.warn("AgentPier could not pass a renewed ChatGPT login on to a runtime."),
        );
  }
  has(profileId) {
    return this.records.has(profileId);
  }
  /** The logins without any token: `{ profileId, name, email, plan, status, expires }`. */
  list() {
    return [...this.records.values()].map((r) => this.view(r.profileId));
  }
  view(profileId) {
    const r = this.records.get(profileId);
    if (!r) return null;
    return {
      profileId: r.profileId,
      name: r.displayName || r.email || "ChatGPT",
      ...(r.email && { email: r.email }),
      ...(r.plan && { plan: r.plan }),
      // "relogin": the refresh token was rejected; only a new sign-in helps.
      status: r.status === "relogin" || !r.refresh ? "relogin" : "ok",
      expires: r.expires,
    };
  }
  /**
   * What a runtime may hold of a login: the access token and its identity, never
   * the refresh token; null after a rejected refresh.
   */
  accessOf(profileId) {
    const r = this.records.get(profileId);
    if (!r || !r.access || !r.refresh || r.status === "relogin") return null;
    return {
      profileId,
      access: r.access,
      expires: r.expires,
      ...(r.accountId && { accountId: r.accountId }),
      ...(r.email && { email: r.email }),
      ...(r.displayName && { displayName: r.displayName }),
      ...(r.plan && { plan: r.plan }),
      ...(r.residency && { residency: r.residency }),
    };
  }
  /**
   * Stores the tokens of a sign-in (or a moved login) under `profileId` (default:
   * chatgptProfileId), saved before anyone uses them. Returns the profile id.
   */
  save(tokens, { profileId = chatgptProfileId(tokens), displayName } = {}) {
    if (!text(tokens?.access, 1e5) || !text(tokens?.refresh, 1e5))
      throw authFailure("LOGIN_FAILED");
    const previous = this.records.get(profileId);
    this.records.set(profileId, {
      profileId,
      access: tokens.access,
      refresh: tokens.refresh,
      expires: Number(tokens.expires) || this.now() + 3600_000,
      issued: this.now(),
      ...(text(tokens.accountId) && { accountId: text(tokens.accountId) }),
      ...(text(tokens.email) && { email: text(tokens.email) }),
      ...((text(displayName) || previous?.displayName) && {
        displayName: text(displayName) || previous.displayName,
      }),
      ...(text(tokens.plan, 60) && { plan: text(tokens.plan, 60) }),
      ...(text(tokens.residency, 60) && { residency: text(tokens.residency, 60) }),
      status: "ok",
      updatedAt: new Date(this.now()).toISOString(),
    });
    this.#persist();
    this.#plan(profileId);
    this.#changed(profileId);
    return profileId;
  }
  /** Forgets a login: AgentPier never redeems its refresh token again. */
  remove(profileId) {
    if (!this.records.delete(profileId)) return false;
    clearTimeout(this.#timers.get(profileId));
    this.#timers.delete(profileId);
    this.#persist();
    this.#changed(profileId);
    return true;
  }
  /**
   * A usable access token of `profileId` (accessOf), refreshed first when it
   * expires within 10 minutes or `force` asks. `stale`: the access token an
   * upstream answered 401 to; refreshed only while it is still the current one, so
   * concurrent 401s redeem the refresh token once.
   */
  async credential(profileId, { stale } = {}) {
    const r = this.records.get(profileId);
    if (!r) throw authFailure("LOGIN_MISSING");
    if (r.status === "relogin" || !r.refresh) throw authFailure("RELOGIN");
    const due = r.expires - this.now() < latestMs;
    if (due || (stale && stale === r.access)) await this.refresh(profileId);
    const current = this.accessOf(profileId);
    if (!current) throw authFailure("RELOGIN");
    if (current.expires <= this.now()) throw authFailure("REFRESH_FAILED");
    return current;
  }
  /** Redeems the refresh token once; concurrent callers share the redemption. */
  refresh(profileId) {
    if (this.#inflight.has(profileId)) return this.#inflight.get(profileId);
    const task = this.#refreshOnce(profileId).finally(() =>
      this.#inflight.delete(profileId),
    );
    this.#inflight.set(profileId, task);
    return task;
  }
  async #refreshOnce(profileId) {
    const r = this.records.get(profileId);
    if (!r?.refresh || r.status === "relogin") return;
    try {
      const tokens = await this.auth.refresh(r.refresh);
      // A logout during the request: the answer is dropped, never stored.
      if (this.records.get(profileId) !== r) return;
      this.save(
        { ...r, ...tokens, accountId: tokens.accountId || r.accountId },
        { profileId },
      );
    } catch (error) {
      if (this.records.get(profileId) !== r) return;
      if (error.code === "REFRESH_REJECTED") {
        this.records.set(profileId, {
          ...r,
          access: undefined,
          refresh: undefined,
          status: "relogin",
          updatedAt: new Date(this.now()).toISOString(),
        });
        this.#persist();
        this.warn(`A ChatGPT login needs a new sign-in (${error.oauthError}).`);
        this.#changed(profileId);
        return;
      }
      this.warn(`A ChatGPT login could not be renewed yet (${error.code}).`);
      this.#plan(profileId, this.now() + retryMs);
      throw error;
    }
  }
  #plan(profileId, at) {
    if (!this.schedule) return;
    clearTimeout(this.#timers.get(profileId));
    const r = this.records.get(profileId);
    if (!r?.refresh || r.status === "relogin") return this.#timers.delete(profileId);
    const when = at ?? refreshAt({ issued: r.issued ?? this.now(), expires: r.expires });
    const delay = Math.min(Math.max(0, when - this.now()), maxTimerMs);
    const timer = setTimeout(() => {
      if (when - this.now() > 1000) return this.#plan(profileId, when);
      this.refresh(profileId).catch(() => {});
    }, delay);
    timer.unref?.();
    this.#timers.set(profileId, timer);
  }
  close() {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#listeners.clear();
  }
}
