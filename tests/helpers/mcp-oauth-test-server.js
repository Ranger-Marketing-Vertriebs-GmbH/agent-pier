import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { echoServer } from "./mcp-test-servers.js";

// A local OAuth 2.1 authorization server and a protected Streamable HTTP MCP server
// on one 127.0.0.1 origin, shaped after the MCP SDK's client expectations:
// - RFC 9728 protected resource metadata, announced by `WWW-Authenticate` on 401;
// - RFC 8414 authorization server metadata;
// - RFC 7591 dynamic client registration for public clients;
// - the authorization code grant with PKCE S256, auto-approved: `/authorize`
//   redirects straight to the registered redirect URI with a code and the state;
// - the refresh token grant with rotation, and revocation of all refresh tokens.
// The MCP endpoint `/mcp` accepts only unexpired access tokens and exposes `echo`.

const random = () => randomBytes(16).toString("hex");
const s256 = (verifier) => createHash("sha256").update(verifier).digest("base64url");

async function body(req) {
  let bytes = "";
  for await (const part of req) bytes += part;
  return bytes;
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(value));
}

/**
 * `options.expiresIn` (seconds) applies to each access token issued from then on and
 * can be changed through `state.expiresIn`; `state.rejectTokens` makes `/mcp` refuse
 * every token, even a freshly refreshed one. `log` records every OAuth request (a
 * refused token request with its cause); `calls` every tool call with the token it
 * arrived with.
 */
export async function oauthMcpServer({ expiresIn = 3600 } = {}) {
  const state = { expiresIn, refreshRevoked: false, rejectTokens: false };
  const clients = new Map();
  const codes = new Map();
  const access = new Map();
  const refresh = new Map();
  const log = [];
  const calls = [];
  let origin;

  const resourceMetadataUrl = () => `${origin}/.well-known/oauth-protected-resource/mcp`;
  const issue = (clientId) => {
    const accessToken = `at-${random()}`;
    const refreshToken = `rt-${random()}`;
    access.set(accessToken, { clientId, expiresAt: Date.now() + state.expiresIn * 1000 });
    refresh.set(refreshToken, { clientId });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: state.expiresIn,
      refresh_token: refreshToken,
    };
  };

  async function token(req, res) {
    const form = new URLSearchParams(await body(req));
    const grant = form.get("grant_type");
    const clientId = form.get("client_id");
    const entry = { path: "/token", grant, clientId };
    log.push(entry);
    // `refused` tells a failed exchange's cause; the response carries only the error.
    const fail = (error, refused = error) => {
      entry.refused = refused;
      return json(res, 400, { error });
    };
    if (!clients.has(clientId)) return fail("invalid_client");
    if (grant === "authorization_code") {
      const code = codes.get(form.get("code"));
      codes.delete(form.get("code"));
      if (!code) return fail("invalid_grant", "unknown or used code");
      if (code.clientId !== clientId)
        return fail("invalid_grant", "code of another client");
      if (code.redirectUri !== form.get("redirect_uri"))
        return fail("invalid_grant", "redirect_uri mismatch");
      if (s256(form.get("code_verifier") ?? "") !== code.challenge)
        return fail("invalid_grant", "code_verifier mismatch");
      return json(res, 200, issue(clientId));
    }
    if (grant === "refresh_token") {
      const old = refresh.get(form.get("refresh_token"));
      if (state.refreshRevoked || !old || old.clientId !== clientId)
        return fail("invalid_grant", "refresh token refused");
      refresh.delete(form.get("refresh_token"));
      return json(res, 200, issue(clientId));
    }
    return fail("unsupported_grant_type");
  }

  async function register(req, res) {
    const metadata = JSON.parse(await body(req));
    log.push({ path: "/register", metadata });
    if (!Array.isArray(metadata.redirect_uris) || metadata.redirect_uris.length === 0)
      return json(res, 400, { error: "invalid_redirect_uri" });
    const clientId = `client-${random()}`;
    clients.set(clientId, metadata);
    json(res, 201, {
      ...metadata,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    });
  }

  function authorize(url, res) {
    const q = url.searchParams;
    const client = clients.get(q.get("client_id"));
    log.push({ path: "/authorize", query: Object.fromEntries(q) });
    if (!client || !client.redirect_uris.includes(q.get("redirect_uri")))
      return json(res, 400, { error: "invalid_request" });
    if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256")
      return json(res, 400, { error: "invalid_request" });
    const code = `code-${random()}`;
    codes.set(code, {
      clientId: q.get("client_id"),
      redirectUri: q.get("redirect_uri"),
      challenge: q.get("code_challenge"),
    });
    const target = new URL(q.get("redirect_uri"));
    target.searchParams.set("code", code);
    if (q.has("state")) target.searchParams.set("state", q.get("state"));
    res.writeHead(302, { location: target.href }).end();
  }

  async function mcp(req, res) {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const grant = bearer && access.get(bearer);
    if (!grant || grant.expiresAt <= Date.now() || state.rejectTokens) {
      log.push({ path: "/mcp", rejected: bearer ? "invalid" : "missing" });
      res.writeHead(401, {
        "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl()}"`,
      });
      res.end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(await body(req));
    } catch {
      res.writeHead(400).end();
      return;
    }
    const server = echoServer("oauth-echo", (call) => calls.push({ ...call, bearer }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  }

  const listener = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
        return json(res, 200, {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          bearer_methods_supported: ["header"],
        });
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return json(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      if (url.pathname === "/register" && req.method === "POST")
        return await register(req, res);
      if (url.pathname === "/authorize" && req.method === "GET")
        return authorize(url, res);
      if (url.pathname === "/token" && req.method === "POST")
        return await token(req, res);
      if (url.pathname === "/mcp") return await mcp(req, res);
      res.writeHead(404).end();
    } catch {
      if (!res.headersSent) json(res, 500, { error: "server_error" });
    }
  });
  await new Promise((r) => listener.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${listener.address().port}`;
  return {
    origin,
    url: `${origin}/mcp`,
    state,
    log,
    calls,
    clients,
    /** Rejects every refresh token from now on, as an authorization server revocation. */
    revokeRefreshTokens() {
      state.refreshRevoked = true;
    },
    /** Lets every issued access token expire now. */
    expireAccessTokens() {
      for (const grant of access.values()) grant.expiresAt = 0;
    },
    close: () =>
      new Promise((r) => {
        listener.closeAllConnections();
        listener.close(r);
      }),
  };
}

/**
 * Plays the user's browser: opens the authorization URL without following the
 * redirect and returns the callback URL the authorization server redirected to.
 */
export async function approve(authorizationUrl) {
  const res = await fetch(authorizationUrl, { redirect: "manual" });
  if (res.status !== 302) throw new Error(`authorize answered ${res.status}`);
  return new URL(res.headers.get("location"));
}
