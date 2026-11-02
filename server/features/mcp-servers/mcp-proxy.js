import { Readable, Transform } from "node:stream";
import { forwardHeaders, proxyError, readBody } from "../model-logins/runtime-proxy.js";

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
 * `oauth`: AgentPierMcpOAuth; `authorize(serverId, consumer)`: whether the
 * credential's agent (or the OpenClaw Gateway) may still use the server.
 */
export function mcpRoute({
  servers,
  oauth,
  authorize = () => false,
  fetch: fetchImpl = globalThis.fetch,
}) {
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
    const send = async (stale) => {
      const token = await oauth.token(server, { stale });
      const response = await fetchImpl(target, {
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
    const stream = Readable.fromWeb(response.body).on("error", () => res.destroy());
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
