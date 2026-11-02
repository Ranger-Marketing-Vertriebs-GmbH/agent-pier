import http from "node:http";
import { randomBytes } from "node:crypto";

// A stand-in for ChatGPT's OAuth endpoints (auth.openai.com) and the Codex backend
// (chatgpt.com/backend-api/codex): synthetic tokens only, never a real OpenAI call.

/** An unsigned JWT with `claims` (OpenAI's signature is never checked by AgentPier). */
export const fakeJwt = (claims) =>
  [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "sig",
  ].join(".");

/** An access token shaped like ChatGPT's: account, plan, residency and e-mail claims. */
export function fakeAccess({
  accountId = "acct-fixture",
  email = "owner@example.invalid",
  plan = "plus",
  residency,
  expires = Date.now() + 3600_000,
  nonce = randomBytes(6).toString("hex"),
} = {}) {
  return fakeJwt({
    exp: Math.floor(expires / 1000),
    nonce,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: plan,
      ...(residency && { chatgpt_compute_residency: residency }),
    },
    "https://api.openai.com/profile": { email },
  });
}

const readBody = async (req) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text;
};

/**
 * Starts the fake issuer. `pending`: device polls answered 403 before the code is
 * confirmed. Refresh tokens rotate and are single-use: a second redemption answers
 * `refresh_token_reused`, as OpenAI does. `state` records every call.
 */
export async function startFakeChatgptOAuth({
  pending = 1,
  lifetimeSec = 3600,
  account = {},
} = {}) {
  const state = { calls: [], refreshes: 0, valid: new Set(), used: new Set(), polls: 0 };
  const issue = () => {
    const refresh = `rt-${randomBytes(8).toString("hex")}`;
    state.valid.add(refresh);
    return {
      access_token: fakeAccess({ ...account, expires: Date.now() + lifetimeSec * 1000 }),
      refresh_token: refresh,
      id_token: fakeJwt({ email: account.email || "owner@example.invalid" }),
      expires_in: lifetimeSec,
    };
  };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    state.calls.push({ method: req.method, url: req.url, headers: req.headers, body });
    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/api/accounts/deviceauth/usercode")
      return send(200, {
        device_auth_id: "dev-1",
        user_code: "ABCD-EFGHI",
        interval: 0.01,
      });
    if (req.url === "/api/accounts/deviceauth/token") {
      if (state.polls++ < pending) return send(403, { error: "authorization_pending" });
      return send(200, { authorization_code: "code-1", code_verifier: "verifier-1" });
    }
    if (req.url === "/oauth/token") {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "authorization_code") {
        if (form.get("code") !== "code-1" || form.get("code_verifier") !== "verifier-1")
          return send(400, { error: "invalid_grant" });
        return send(200, issue());
      }
      if (form.get("grant_type") === "refresh_token") {
        state.refreshes++;
        const token = form.get("refresh_token");
        if (state.used.has(token)) return send(401, { error: "refresh_token_reused" });
        if (!state.valid.has(token)) return send(400, { error: "invalid_grant" });
        state.valid.delete(token);
        state.used.add(token);
        return send(200, issue());
      }
    }
    send(404, { error: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    /** A token pair the fake accepts, as a login elsewhere would have made. */
    issue,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}
