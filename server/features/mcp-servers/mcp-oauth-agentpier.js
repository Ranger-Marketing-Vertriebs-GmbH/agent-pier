import path from "node:path";
import { randomUUID } from "node:crypto";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { privateDirectory, readJSON, writePrivate } from "../../lib/storage.js";
import { oauthFetch } from "./oauth-fetch.js";

// OAuth logins of central MCP servers that AgentPier runs and holds itself (MCP SDK
// `auth()`: RFC 9728 protected resource metadata, RFC 8414 discovery, RFC 7591
// dynamic client registration as a public client, PKCE S256, RFC 8707 resource),
// returning to AgentPier's existing callback (oauth-redirect.js). AgentPier is the
// only refresher of these tokens; both runtimes reach the server through the MCP
// proxy (mcp-proxy.js) with a credential for that server alone. Every request of the
// flow, on a login and on a renewal, passes the address check of oauth-fetch.js: the
// server's metadata names the URLs AgentPier fetches.
//
// The vault (<data>/model-logins/mcp-oauth.json, owner-only) keeps per server id the
// server's name and URL the login is for, the client registration and its redirect
// URL, and the tokens. A record exists from the first completed login on: the
// server is then AgentPier's ("held") and stays so after a logout, so it never goes
// back to an OpenClaw login. Pending logins live in memory only, like before.

const refreshSkewMs = 30_000;
export const pendingMs = 10 * 60 * 1000;

const clean = (record) => {
  const out = {};
  for (const [key, value] of Object.entries(record))
    if (value !== undefined) out[key] = value;
  return out;
};

export class McpOAuthVault {
  constructor({ dataDir }) {
    this.file = path.join(dataDir, "model-logins", "mcp-oauth.json");
    const saved = readJSON(this.file, { servers: [] });
    this.records = new Map(
      (Array.isArray(saved?.servers) ? saved.servers : [])
        .filter((r) => typeof r?.serverId === "string")
        .map((r) => [r.serverId, r]),
    );
  }
  #persist() {
    privateDirectory(path.dirname(this.file));
    writePrivate(this.file, { version: 1, servers: [...this.records.values()] });
  }
  get(serverId) {
    return this.records.get(serverId) || null;
  }
  /** Whether AgentPier holds this server's login (from its first login on). */
  held(serverId) {
    return this.records.get(serverId)?.held === true;
  }
  patch(serverId, patch) {
    const next = clean({ ...this.records.get(serverId), serverId, ...patch });
    this.records.set(serverId, next);
    this.#persist();
    return next;
  }
  remove(serverId) {
    if (this.records.delete(serverId)) this.#persist();
  }
}

/** The SDK's OAuthClientProvider over one server's vault record. */
class VaultProvider {
  constructor(vault, server, { redirectUrl, state, verifier } = {}) {
    Object.assign(this, { vault, server, redirect: redirectUrl, stateValue: state });
    this.verifier = verifier;
    this.authorizationUrl = null;
  }
  get redirectUrl() {
    return this.redirect;
  }
  get clientMetadata() {
    return {
      client_name: "AgentPier",
      redirect_uris: this.redirect ? [this.redirect] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.server.oauthScope && { scope: this.server.oauthScope }),
    };
  }
  state() {
    return this.stateValue;
  }
  // A registration is kept for the redirect and URL it was made for; a new one of
  // either registers again (the authorization server knows only the old redirect).
  clientInformation() {
    const record = this.vault.get(this.server.id);
    const client = record?.client;
    if (!client || client.url !== this.server.url) return undefined;
    if (this.redirect && client.redirectUrl !== this.redirect) return undefined;
    return client.info;
  }
  saveClientInformation(info) {
    this.vault.patch(this.server.id, {
      client: { info, redirectUrl: this.redirect, url: this.server.url },
    });
  }
  tokens() {
    const record = this.vault.get(this.server.id);
    return record?.url === this.server.url ? record.tokens : undefined;
  }
  saveTokens(tokens) {
    this.vault.patch(this.server.id, {
      tokens,
      obtainedAt: Date.now(),
      name: this.server.name,
      url: this.server.url,
      held: true,
      relogin: undefined,
    });
  }
  redirectToAuthorization(url) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier) {
    this.verifier = verifier;
  }
  codeVerifier() {
    if (!this.verifier) throw new Error("No code verifier");
    return this.verifier;
  }
  invalidateCredentials(scope) {
    const record = this.vault.get(this.server.id);
    if (!record) return;
    if (scope === "all" || scope === "client")
      this.vault.patch(this.server.id, { client: undefined });
    if (scope === "all" || scope === "tokens")
      this.vault.patch(this.server.id, { tokens: undefined, obtainedAt: undefined });
  }
}

const failure = (code) => Object.assign(new Error(code), { code });

export class AgentPierMcpOAuth {
  #refreshing = new Map();
  constructor({
    dataDir,
    vault = new McpOAuthVault({ dataDir }),
    fetch,
    lookup,
    now = Date.now,
  }) {
    // `fetch` and `lookup` replace the checked request and the DNS lookup in tests.
    Object.assign(this, { vault, fetchFn: fetch, lookup, now });
    this.pending = new Map(); // state -> { serverId, name, url, verifier, redirectUrl, startedAt }
  }
  held(serverId) {
    return this.vault.held(serverId);
  }
  #options(server, extra = {}) {
    return {
      serverUrl: server.url,
      ...(server.oauthScope && { scope: server.oauthScope }),
      fetchFn: oauthFetch(server.url, {
        ...(this.lookup && { lookup: this.lookup }),
        ...(this.fetchFn && { send: (url, init) => this.fetchFn(url, init) }),
      }),
      ...extra,
    };
  }
  /**
   * Starts a login of `server` (its stored definition) returning to `redirectUrl`:
   * `{ authorizationUrl, state }`, or `{ connected: true }` when a renewal of the
   * tokens AgentPier holds was enough.
   */
  async start(server, { redirectUrl }) {
    for (const [state, login] of this.pending)
      if (login.serverId === server.id) this.pending.delete(state);
    const state = randomUUID();
    const provider = new VaultProvider(this.vault, server, { redirectUrl, state });
    let result;
    try {
      result = await auth(provider, this.#options(server));
    } catch (error) {
      throw Object.assign(failure("oauth-failed"), { cause: error });
    }
    if (result === "AUTHORIZED") return { connected: true };
    this.pending.set(state, {
      serverId: server.id,
      name: server.name,
      url: server.url,
      verifier: provider.verifier,
      redirectUrl,
      startedAt: this.now(),
    });
    return { authorizationUrl: provider.authorizationUrl.href, state };
  }
  /** The pending login of `state` (single use), or null. */
  take(state) {
    const login = typeof state === "string" ? this.pending.get(state) : undefined;
    if (!login) return null;
    this.pending.delete(state);
    return this.now() - login.startedAt < pendingMs ? login : null;
  }
  pendingFor(serverId) {
    for (const login of this.pending.values())
      if (login.serverId === serverId && this.now() - login.startedAt < pendingMs)
        return login;
    return null;
  }
  /** Exchanges the code of a taken login for tokens; the server becomes held. */
  async complete(login, server, code) {
    const provider = new VaultProvider(this.vault, server, {
      redirectUrl: login.redirectUrl,
      verifier: login.verifier,
    });
    const result = await auth(
      provider,
      this.#options(server, { authorizationCode: code }),
    );
    if (result !== "AUTHORIZED") throw failure("oauth-failed");
  }
  /** Drops the tokens; the server stays AgentPier's and needs a new login. */
  logout(serverId) {
    if (this.vault.get(serverId))
      this.vault.patch(serverId, { tokens: undefined, obtainedAt: undefined });
    for (const [state, login] of this.pending)
      if (login.serverId === serverId) this.pending.delete(state);
  }
  /** Forgets the server altogether (deleted, renamed or moved to another URL). */
  forget(serverId) {
    this.vault.remove(serverId);
    for (const [state, login] of this.pending)
      if (login.serverId === serverId) this.pending.delete(state);
  }
  #expiresAt(record) {
    const lifetime = Number(record?.tokens?.expires_in);
    return Number.isFinite(lifetime) && record.obtainedAt
      ? record.obtainedAt + lifetime * 1000
      : Infinity;
  }
  /** "connected", "login-pending", "login-required" or "not-connected", and expiry. */
  status(server) {
    const record = this.vault.get(server.id);
    const tokens = record?.url === server.url ? record.tokens : null;
    if (tokens?.access_token)
      return {
        oauthStatus: "connected",
        ...(Number.isFinite(this.#expiresAt(record)) && {
          oauthExpiresAt: new Date(this.#expiresAt(record)).toISOString(),
        }),
      };
    if (this.pendingFor(server.id)) return { oauthStatus: "login-pending" };
    return { oauthStatus: record?.held ? "login-required" : "not-connected" };
  }
  /**
   * The access token of `server` for the proxy, renewed first when it expires within
   * 30 seconds or when `stale` (the token an upstream answered 401 to) is still the
   * current one. Concurrent callers share one renewal. Throws LOGIN_REQUIRED when
   * only a new login helps.
   */
  async token(server, { stale } = {}) {
    const record = this.vault.get(server.id);
    const tokens = record?.url === server.url ? record.tokens : null;
    if (!tokens?.access_token) throw failure("LOGIN_REQUIRED");
    const due = this.#expiresAt(record) - this.now() < refreshSkewMs;
    if (!due && !(stale && stale === tokens.access_token)) return tokens.access_token;
    if (!tokens.refresh_token) {
      if (due) throw failure("LOGIN_REQUIRED");
      return tokens.access_token;
    }
    if (!this.#refreshing.has(server.id))
      this.#refreshing.set(
        server.id,
        this.#refresh(server).finally(() => this.#refreshing.delete(server.id)),
      );
    await this.#refreshing.get(server.id);
    const next = this.vault.get(server.id)?.tokens;
    if (!next?.access_token) throw failure("LOGIN_REQUIRED");
    return next.access_token;
  }
  async #refresh(server) {
    // The registration's redirect: without one the SDK runs a non-interactive grant.
    const provider = new VaultProvider(this.vault, server, {
      redirectUrl: this.vault.get(server.id)?.client?.redirectUrl,
    });
    let result;
    try {
      result = await auth(provider, this.#options(server));
    } catch (error) {
      // A revoked or reused refresh token: the SDK invalidated the tokens.
      if (!this.vault.get(server.id)?.tokens) throw failure("LOGIN_REQUIRED");
      throw Object.assign(failure("REFRESH_FAILED"), { cause: error });
    }
    // The SDK asked for a browser: the refresh token was refused.
    if (result !== "AUTHORIZED") {
      this.vault.patch(server.id, { tokens: undefined, obtainedAt: undefined });
      throw failure("LOGIN_REQUIRED");
    }
  }
}
