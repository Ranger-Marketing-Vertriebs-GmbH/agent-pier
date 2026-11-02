// ChatGPT's OAuth endpoints for the public Codex CLI client, which OpenClaw and Hermes
// use alike (OpenClaw 2026.10.9 extensions/openai/openai-chatgpt-device-code.js,
// Hermes v0.22.5 hermes_cli/auth_constants.py and auth_codex.py). AgentPier runs the
// device-code flow itself: the redirect of the browser flow is fixed to
// localhost:1455 and cannot reach a remote owner's browser.

export const chatgptClientId = "app_EMoamEEZ73f0CkXaXp7hrann";
export const chatgptIssuer = "https://auth.openai.com";
export const chatgptLoginUrl = `${chatgptIssuer}/codex/device`;
// The device authorization ends after 15 minutes on OpenAI's side.
export const deviceLoginMs = 15 * 60 * 1000;
const requestTimeoutMs = 30_000;
const authClaim = "https://api.openai.com/auth";
const profileClaim = "https://api.openai.com/profile";
// Refresh failures that need a new sign-in: the refresh token is gone for good.
export const terminalRefreshErrors = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

/** A failure with a stable code; never a token, code or upstream message. */
export const authFailure = (code, details = {}) =>
  Object.assign(new Error(code), { code, ...details });

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : "");
const headers = (contentType) => ({
  "Content-Type": contentType,
  Accept: "application/json",
  originator: "agentpier",
  "User-Agent": "agentpier",
});

/** The payload of a JWT, or null; the signature is OpenAI's to check, not ours. */
export function jwtPayload(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(String(token).split(".")[1] || "", "base64url").toString("utf8"),
    );
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : null;
  } catch {
    return null;
  }
}

/**
 * What a ChatGPT access token (or its id token) says about the account: `{
 * accountId, email, plan, residency, expires }`, each only when present. The
 * residency becomes `x-openai-internal-codex-residency` (Hermes codex_headers.py).
 */
export function tokenIdentity(access, idToken) {
  const claims = jwtPayload(access) || {};
  const identity = jwtPayload(idToken) || {};
  const auth = { ...identity[authClaim], ...claims[authClaim] };
  const email =
    text(claims[profileClaim]?.email) || text(identity.email) || text(claims.email);
  return {
    ...(text(auth.chatgpt_account_id) && { accountId: text(auth.chatgpt_account_id) }),
    ...(email && { email }),
    ...(text(auth.chatgpt_plan_type) && { plan: text(auth.chatgpt_plan_type) }),
    ...((text(auth.chatgpt_compute_residency) || text(auth.chatgpt_data_residency)) && {
      residency:
        text(auth.chatgpt_compute_residency) || text(auth.chatgpt_data_residency),
    }),
    ...(Number.isFinite(claims.exp) && { expires: claims.exp * 1000 }),
  };
}

/**
 * The ChatGPT OAuth client. `fetch` and `issuer` are replaceable for tests; nothing
 * here logs or returns an upstream body.
 */
export class ChatGptAuth {
  constructor({ fetch: fetchImpl = globalThis.fetch, issuer = chatgptIssuer } = {}) {
    this.fetch = fetchImpl;
    this.issuer = issuer;
  }
  async #post(pathname, body, { form = false, signal } = {}) {
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    let response;
    try {
      response = await this.fetch(`${this.issuer}${pathname}`, {
        method: "POST",
        headers: headers(form ? "application/x-www-form-urlencoded" : "application/json"),
        body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: "error",
      });
    } catch (error) {
      if (signal?.aborted) throw authFailure("LOGIN_CANCELLED");
      throw authFailure("NETWORK", { cause: error });
    }
    let json = null;
    try {
      json = JSON.parse((await response.text()).slice(0, 262144));
    } catch {
      json = null;
    }
    return { status: response.status, ok: response.ok, json: json || {} };
  }
  /** Starts a device login: `{ deviceAuthId, userCode, intervalMs }`. */
  async startDevice({ signal } = {}) {
    const result = await this.#post(
      "/api/accounts/deviceauth/usercode",
      { client_id: chatgptClientId },
      { signal },
    );
    if (result.status === 404) throw authFailure("LOGIN_UNAVAILABLE");
    if (!result.ok) throw authFailure("LOGIN_FAILED", { status: result.status });
    const deviceAuthId = text(result.json.device_auth_id);
    const userCode = text(result.json.user_code) || text(result.json.usercode);
    if (!deviceAuthId || !/^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/.test(userCode))
      throw authFailure("UNSUPPORTED_LOGIN_STEP");
    const interval = Number(result.json.interval);
    return {
      deviceAuthId,
      userCode,
      intervalMs: Number.isFinite(interval) && interval > 0 ? interval * 1000 : 5000,
    };
  }
  /**
   * One poll of a device login: null while the owner has not confirmed (403/404),
   * else the tokens of the exchanged code.
   */
  async pollDevice({ deviceAuthId, userCode, signal }) {
    const result = await this.#post(
      "/api/accounts/deviceauth/token",
      { device_auth_id: deviceAuthId, user_code: userCode },
      { signal },
    );
    if (result.status === 403 || result.status === 404) return null;
    if (!result.ok) throw authFailure("LOGIN_FAILED", { status: result.status });
    const code = text(result.json.authorization_code);
    const verifier = text(result.json.code_verifier);
    if (!code || !verifier) throw authFailure("LOGIN_FAILED");
    return this.#tokens(
      await this.#post(
        "/oauth/token",
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: `${this.issuer}/deviceauth/callback`,
          client_id: chatgptClientId,
          code_verifier: verifier,
        },
        { form: true, signal },
      ),
    );
  }
  /**
   * Redeems `refresh` once: the new tokens (OpenAI may rotate the refresh token;
   * the old one stays when none comes back), or `REFRESH_REJECTED` with the OAuth
   * error when the token is gone for good.
   */
  async refresh(refresh) {
    const result = await this.#post(
      "/oauth/token",
      { grant_type: "refresh_token", refresh_token: refresh, client_id: chatgptClientId },
      { form: true },
    );
    const error =
      typeof result.json.error === "string"
        ? result.json.error
        : typeof result.json.error?.code === "string"
          ? result.json.error.code
          : "";
    if (!result.ok && (terminalRefreshErrors.has(error) || result.status === 401))
      throw authFailure("REFRESH_REJECTED", { oauthError: error || "unauthorized" });
    if (!result.ok) throw authFailure("REFRESH_FAILED", { status: result.status });
    return this.#tokens(result, refresh);
  }
  #tokens(result, previousRefresh) {
    if (!result.ok) throw authFailure("LOGIN_FAILED", { status: result.status });
    const access = text(result.json.access_token);
    const refresh = text(result.json.refresh_token) || previousRefresh;
    if (!access || !refresh) throw authFailure("LOGIN_FAILED");
    const identity = tokenIdentity(access, result.json.id_token);
    const lifetime = Number(result.json.expires_in);
    const expires =
      Number.isFinite(lifetime) && lifetime > 0
        ? Date.now() + lifetime * 1000
        : identity.expires || Date.now() + 3600_000;
    return { access, refresh, ...identity, expires };
  }
}
