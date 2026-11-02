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

// The text of the last user item of a Responses request.
function lastUserText(body) {
  const items = Array.isArray(body?.input) ? body.input : [];
  const user = items.filter((item) => item?.role === "user").at(-1);
  const content = Array.isArray(user?.content) ? user.content : [];
  return content.map((part) => part?.text || "").join("") || String(user?.content || "");
}

/**
 * A Codex backend (`/backend-api/codex/responses`, `/backend-api/codex/models`): it
 * streams "CODEX: <last user text>" as Responses SSE events, one write per event.
 * `reject`: access tokens it answers 401 to (a revoked token). `requests` records
 * method, URL, headers and parsed body.
 */
export async function startFakeCodex({ models = ["gpt-5.4"] } = {}) {
  const requests = [];
  const reject = new Set();
  const server = http.createServer(async (req, res) => {
    const text = await readBody(req);
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
    if (reject.has(token)) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": "Bearer",
      });
      return res.end(JSON.stringify({ error: { code: "token_expired" } }));
    }
    if (req.url.startsWith("/backend-api/codex/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          models: models.map((slug) => ({
            slug,
            display_name: slug,
            context_window: 272000,
            supported_in_api: true,
            visibility: "list",
          })),
        }),
      );
    }
    if (req.url !== "/backend-api/codex/responses") {
      res.writeHead(404);
      return res.end();
    }
    const reply = `CODEX: ${lastUserText(body)}`;
    const id = `resp_${randomBytes(4).toString("hex")}`;
    const item = {
      id: `msg_${randomBytes(4).toString("hex")}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: reply, annotations: [] }],
    };
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    const events = [
      { type: "response.created", response: { id, status: "in_progress" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: item.id,
        delta: reply,
      },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id,
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ];
    for (const event of events)
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/backend-api`,
    requests,
    reject,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}
