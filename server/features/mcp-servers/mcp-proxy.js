import { Transform } from "node:stream";
import { forwardHeaders, proxyError, readBody } from "../model-logins/runtime-proxy.js";
import { RedirectRefused, plainBody, upstreamRequest } from "./upstream-request.js";

// The MCP part of AgentPier's runtime proxy (model-logins/runtime-proxy.js):
// `/mcp/<serverId>` is a Streamable HTTP passthrough to an OAuth MCP server whose
// login AgentPier holds (mcp-oauth-agentpier.js). For a server on the legacy HTTP+SSE
// transport it passes the GET event stream, rewriting its `endpoint` event to
// `/mcp/<serverId>/message?target=<path>`, and forwards POSTs there to the announced
// URL on the server's own origin. POST, GET (the server's SSE
// stream) and DELETE (session end) pass with their bodies and the protocol headers
// (Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, Accept); the proxy adds the
// server's current access token. On a 401 it renews the token once and replays the
// request; the upstream's WWW-Authenticate never reaches the runtime, so neither
// OpenClaw nor Hermes starts an OAuth flow of its own. OpenClaw and Hermes compile
// the server as a plain HTTP server with the proxy URL and its credential
// (mcp-inputs.js proxiedServers).
//
// Every request to the server goes through upstream-request.js: it connects to the
// addresses it resolved, and a redirect the server answers is followed there under the
// address rule of the OAuth flow (the server's origin, or an address no more internal
// than the server; at most 5 hops), with the access token and the MCP session id only
// on the server's own origin. A redirect that is not followed ends as 502
// `upstream_redirect_refused`; a `Location` never reaches the runtime, which would
// follow it on its own.

const responseDropped = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "www-authenticate",
  "location",
]);

/**
 * `servers.definition(id)`: the stored definition (unredacted URL) or null;
 * `oauth`: AgentPierMcpOAuth; `authorize(serverId, consumer)`: whether the
 * credential's agent (or the OpenClaw Gateway) may still use the server.
 * `warn` reports a redirect that was not followed, once per server and target;
 * `lookup` and `send` replace the DNS lookup and the pinned request in tests.
 */
export function mcpRoute({
  servers,
  oauth,
  authorize = () => false,
  warn = () => {},
  lookup,
  send: sendImpl,
}) {
  const warned = new Set();
  return async (req, res, { scope, rest, search }) => {
    const [, serverId, consumer] = scope;
    // `/mcp/<id>`, and for an SSE server its message endpoint `/mcp/<id>/message`.
    const message = rest === `${serverId}/message`;
    if (
      (rest !== serverId && !message) ||
      !["GET", "POST", "DELETE"].includes(req.method)
    )
      return proxyError(res, 404, "not_found", "Unknown MCP route.");
    const server = servers.definition(serverId);
    if (!server || server.auth !== "oauth" || !oauth.held(serverId))
      return proxyError(res, 404, "not_found", "Unknown MCP server.");
    const sse = server.transport === "sse";
    // The message endpoint the SSE server announced, on the server's own origin.
    const target = message
      ? messageTarget(server, search)
      : `${server.url}${search || ""}`;
    if (!target || (message && (!sse || req.method !== "POST")))
      return proxyError(res, 404, "not_found", "Unknown MCP route.");
    // Only the agents bound to this server (proxy-access.js), checked per request.
    if (!consumer || !(await authorize(serverId, consumer)))
      return proxyError(res, 403, "forbidden", "This agent may not use this MCP server.");
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
    const upstream = upstreamRequest(server.url, {
      lookup,
      ...(sendImpl && { send: sendImpl }),
    });
    const send = async (stale) => {
      const token = await oauth.token(server, { stale });
      const result = await upstream(target, {
        method: req.method,
        headers: forwardHeaders(req.headers, [
          "cookie",
          "accept-encoding",
          "authorization",
        ]),
        credentials: { authorization: `Bearer ${token}` },
        body,
        signal: abort.signal,
      });
      return { ...result, token };
    };
    let result;
    try {
      result = await send();
      // Only the server itself can say that its token is stale.
      if (result.response.statusCode === 401 && result.own) {
        result.response.on("error", () => {}).destroy();
        result = await send(result.token);
      }
    } catch (error) {
      if (abort.signal.aborted) return res.destroy();
      if (error instanceof RedirectRefused) {
        const key = `${serverId} ${error.reason} ${error.target}`;
        if (!warned.has(key) && warned.size < 200) {
          warned.add(key);
          warn(
            `AgentPier did not follow a redirect of the MCP server "${server.name}" (${error.reason}${error.target ? `, to ${error.target}` : ""}).`,
          );
        }
        return proxyError(
          res,
          502,
          "upstream_redirect_refused",
          "The MCP server redirected to a URL AgentPier does not follow.",
        );
      }
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
    for (const [name, value] of Object.entries(response.headers))
      if (!responseDropped.has(name)) headers[name] = value;
    res.writeHead(response.statusCode, headers);
    res.flushHeaders();
    const stream = plainBody(response).on("error", () => res.destroy());
    // An SSE server's event stream names its message endpoint: the runtime posts there
    // through the proxy, never to the server itself.
    const events =
      sse && !message && /text\/event-stream/.test(headers["content-type"] || "");
    (events ? stream.pipe(endpointRewriter(server, serverId)) : stream).pipe(res);
  };
}

/** The upstream URL of `/mcp/<id>/message?target=…`, or null off the server's origin. */
function messageTarget(server, search) {
  try {
    const encoded = new URLSearchParams(search || "").get("target");
    const url = new URL(
      Buffer.from(encoded || "", "base64url").toString("utf8"),
      server.url,
    );
    return url.origin === new URL(server.url).origin ? url.href : null;
  } catch {
    return null;
  }
}

// Rewrites the `endpoint` event of the legacy HTTP+SSE transport (the server's
// message URL, relative or absolute) to the proxy's message route; every other event
// passes unchanged, each as soon as it is complete.
function endpointRewriter(server, serverId) {
  let buffer = "";
  const rewrite = (block) => {
    const lines = block.split(/\r?\n/);
    if (!lines.some((line) => /^event:\s*endpoint\s*$/.test(line))) return block;
    return lines
      .map((line) => {
        const data = /^data:\s?(.*)$/.exec(line);
        if (!data) return line;
        const upstream = new URL(data[1].trim(), server.url);
        if (upstream.origin !== new URL(server.url).origin) return "data: about:blank";
        const target = Buffer.from(upstream.pathname + upstream.search).toString(
          "base64url",
        );
        return `data: /mcp/${encodeURIComponent(serverId)}/message?target=${target}`;
      })
      .join("\n");
  };
  return new Transform({
    transform(chunk, _encoding, done) {
      buffer += chunk.toString("utf8");
      let out = "";
      for (let at; (at = buffer.search(/\r?\n\r?\n/)) !== -1;) {
        const end = buffer.slice(at).match(/^\r?\n\r?\n/)[0].length;
        out += rewrite(buffer.slice(0, at)) + buffer.slice(at, at + end);
        buffer = buffer.slice(at + end);
      }
      done(null, out);
    },
    flush(done) {
      done(null, buffer ? rewrite(buffer) : "");
    },
  });
}
