import express from "express";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { rateLimit } from "express-rate-limit";
import { TooManyRequestsError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { sourceKey } from "../../http/tailscale-request.js";
import { MCP_SCOPES } from "./oauth-provider.js";

// Dynamic client registration needs no credential, and on the Tailscale host every
// tailnet device reaches it. A client registers once per login, so 20 registrations an
// hour from one sender (the local machine, one tailnet device or one network address)
// are far more than any client needs, and one sender that uses up its window keeps
// nobody else from registering. All senders together get 200 an hour: Tailscale Serve
// reaches AgentPier from loopback, so a local process could name any number of
// devices, and the ceiling also bounds the windows kept in memory. The store keeps at
// most 1,000 registrations and drops the oldest unused one for a new one
// (access-store.js).
export const REGISTRATION_LIMITS = Object.freeze({
  windowMs: 60 * 60_000,
  perSource: 20,
  total: 200,
});

function registrationLimit(limits) {
  const { windowMs, perSource, total } = { ...REGISTRATION_LIMITS, ...limits };
  const window = (limit, keyGenerator) =>
    rateLimit({
      windowMs,
      limit,
      keyGenerator,
      standardHeaders: true,
      legacyHeaders: false,
      message: new TooManyRequestsError(
        "You have exceeded the rate limit for client registration requests",
      ).toResponseObject(),
    });
  // Without the transport check in front (tests), every request counts as local.
  const each = window(perSource, (req) => sourceKey(req, req.mcpSource || "local"));
  const all = window(total, () => "all");
  // The ceiling counts only what passed a sender's own window.
  return (req, res, next) =>
    req.method === "POST"
      ? each(req, res, (error) => (error ? next(error) : all(req, res, next)))
      : next();
}

/**
 * The OAuth endpoints of AgentPier's own MCP endpoint. `limits` overrides
 * `REGISTRATION_LIMITS` in tests.
 */
export function createOAuthRouter(provider, publicUrl, limits = {}) {
  const router = express.Router();
  if (!publicUrl) return router;
  const issuerUrl = new URL(publicUrl);
  const resourceServerUrl = new URL("/mcp", issuerUrl);
  const serviceDocumentationUrl = new URL("/settings/mcp", issuerUrl);
  const endpoint = (pathname) => new URL(pathname, issuerUrl).href;
  // The service validates HTTPS or explicit-port loopback HTTP before composition.
  const metadata = {
    issuer: issuerUrl.href,
    authorization_endpoint: endpoint("/authorize"),
    token_endpoint: endpoint("/token"),
    registration_endpoint: endpoint("/register"),
    revocation_endpoint: endpoint("/revoke"),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: false,
    scopes_supported: MCP_SCOPES,
    service_documentation: serviceDocumentationUrl.href,
  };
  router.use("/.well-known/oauth-authorization-server", metadataHandler(metadata));
  router.use(
    [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ],
    metadataHandler({
      resource: resourceServerUrl.href,
      authorization_servers: [issuerUrl.href],
      scopes_supported: MCP_SCOPES,
      resource_name: "AgentPier",
      resource_documentation: serviceDocumentationUrl.href,
    }),
  );
  router.use(
    "/authorize",
    express.urlencoded({ extended: false, limit: "8kb", parameterLimit: 20 }),
    async (request, response, next) => {
      const params = request.method === "POST" ? request.body : request.query;
      const client = await provider.clientsStore.getClient(params?.client_id);
      if (
        client &&
        params.redirect_uri !== undefined &&
        !client.redirect_uris.includes(params.redirect_uri)
      )
        return response.status(400).json({
          error: "invalid_request",
          error_description: "Unregistered redirect_uri",
        });
      next();
    },
    authorizationHandler({ provider }),
  );
  router.use(
    "/token",
    express.urlencoded({ extended: false, limit: "8kb", parameterLimit: 20 }),
    (request, response, next) => {
      if (
        request.body?.grant_type === "authorization_code" &&
        !/^[A-Za-z0-9._~-]{43,128}$/.test(request.body.code_verifier || "")
      )
        return response
          .status(400)
          .json({ error: "invalid_request", error_description: "Invalid PKCE verifier" });
      next();
    },
    tokenHandler({ provider }),
  );
  router.use(
    "/register",
    registrationLimit(limits),
    express.json({ limit: "8kb" }),
    // The handler's own limit keys on the connection, which is loopback for every
    // tailnet device behind Tailscale Serve: one window for all of them.
    clientRegistrationHandler({ clientsStore: provider.clientsStore, rateLimit: false }),
  );
  router.use(
    "/revoke",
    express.urlencoded({ extended: false, limit: "8kb", parameterLimit: 20 }),
    revocationHandler({ provider }),
  );
  return router;
}
