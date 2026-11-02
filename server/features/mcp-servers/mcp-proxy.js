import { Readable } from "node:stream";
import { forwardHeaders, proxyError, readBody } from "../model-logins/runtime-proxy.js";

// The MCP part of AgentPier's runtime proxy (model-logins/runtime-proxy.js):
// `/mcp/<serverId>` is a Streamable HTTP passthrough to an OAuth MCP server whose
// login AgentPier holds (mcp-oauth-agentpier.js). POST, GET (the server's SSE
// stream) and DELETE (session end) pass with their bodies and the protocol headers
// (Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, Accept); the proxy adds the
// server's current access token. On a 401 it renews the token once and replays the
// request; the upstream's WWW-Authenticate never reaches the runtime, so neither
// OpenClaw nor Hermes starts an OAuth flow of its own. OpenClaw and Hermes compile
// the server as a plain HTTP server with the proxy URL and its credential
// (mcp-inputs.js proxiedServers).

const responseDropped = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "www-authenticate",
]);

/**
 * `servers.definition(id)`: the stored definition (unredacted URL) or null;
 * `oauth`: AgentPierMcpOAuth.
 */
export function mcpRoute({ servers, oauth, fetch: fetchImpl = globalThis.fetch }) {
  return async (req, res, { scope, rest, search }) => {
    const serverId = scope[1];
    if (rest !== serverId || !["GET", "POST", "DELETE"].includes(req.method))
      return proxyError(res, 404, "not_found", "Unknown MCP route.");
    const server = servers.definition(serverId);
    if (!server || server.auth !== "oauth" || !oauth.held(serverId))
      return proxyError(res, 404, "not_found", "Unknown MCP server.");
    let body;
    try {
      body = req.method === "POST" ? await readBody(req) : undefined;
    } catch (error) {
      return proxyError(
        res,
        error.status || 400,
        "invalid_request",
        "Unreadable request.",
      );
    }
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const send = async (stale) => {
      const token = await oauth.token(server, { stale });
      const response = await fetchImpl(`${server.url}${search || ""}`, {
        method: req.method,
        headers: {
          ...forwardHeaders(req.headers, ["cookie", "accept-encoding"]),
          authorization: `Bearer ${token}`,
        },
        body,
        signal: abort.signal,
        redirect: "manual",
      });
      return { response, token };
    };
    let result;
    try {
      result = await send();
      if (result.response.status === 401) {
        await result.response.body?.cancel().catch(() => {});
        result = await send(result.token);
      }
    } catch (error) {
      if (abort.signal.aborted) return res.destroy();
      if (error?.code === "LOGIN_REQUIRED")
        return proxyError(
          res,
          401,
          "agentpier_login_required",
          "Sign in to this MCP server in AgentPier.",
        );
      if (error?.code === "REFRESH_FAILED")
        return proxyError(res, 503, "agentpier_refresh_failed", "Login renewal failed.", {
          "retry-after": "30",
        });
      return proxyError(res, 502, "upstream_unreachable", "MCP server unreachable.");
    }
    const { response } = result;
    const headers = {};
    response.headers.forEach((value, name) => {
      if (!responseDropped.has(name)) headers[name] = value;
    });
    res.writeHead(response.status, headers);
    res.flushHeaders();
    if (!response.body) return res.end();
    Readable.fromWeb(response.body)
      .on("error", () => res.destroy())
      .pipe(res);
  };
}
