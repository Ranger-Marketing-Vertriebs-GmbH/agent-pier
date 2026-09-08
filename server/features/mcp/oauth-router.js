import express from "express";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { MCP_SCOPES } from "./oauth-provider.js";

export function createOAuthRouter(provider, publicUrl) {
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
    express.json({ limit: "8kb" }),
    clientRegistrationHandler({ clientsStore: provider.clientsStore }),
  );
  router.use(
    "/revoke",
    express.urlencoded({ extended: false, limit: "8kb", parameterLimit: 20 }),
    revocationHandler({ provider }),
  );
  return router;
}
