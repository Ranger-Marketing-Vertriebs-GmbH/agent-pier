import crypto from "node:crypto";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

export const MCP_SCOPES = [
  "catalog:read",
  "definitions:write",
  "runs:read",
  "runs:start",
  "runs:cancel",
  "runs:publish",
];
export const randomToken = () => crypto.randomBytes(32).toString("base64url");
const hash = (token) => crypto.createHash("sha256").update(token).digest("hex");
const validOpaque = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
export const safeRedirect = (value) => {
  try {
    const url = new URL(value);
    return (
      value.length <= 2048 &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
};

export function createOAuthProvider({
  store,
  now,
  resource,
  consentUrl,
  onEvent = () => {},
}) {
  const requireResource = (value) => {
    if (!value || value.href !== resource)
      throw new InvalidRequestError("The MCP resource must match this server.");
  };
  const activeGrant = (id) => {
    const grant = store.get("grant", id);
    if (
      !grant ||
      grant.revokedAt ||
      grant.expiresAt <= now() ||
      grant.resource !== resource
    )
      throw new InvalidGrantError("Authorization expired or revoked.");
    return grant;
  };
  const revoke = (id, reason) => {
    const grant = store.get("grant", id);
    if (grant && !grant.revokedAt) {
      store.put("grant", id, { ...grant, revokedAt: now() });
      onEvent({ action: "mcp.revoked", grantId: id, clientId: grant.clientId, reason });
    }
  };
  const codeRecord = (client, code) => {
    const record = validOpaque(code) ? store.get("code", hash(code)) : null;
    if (!record || record.clientId !== client.client_id || record.expiresAt <= now())
      throw new InvalidGrantError("Invalid authorization code.");
    if (record.usedAt) {
      revoke(record.grantId, "code_replay");
      throw new InvalidGrantError("Authorization code already used.");
    }
    activeGrant(record.grantId);
    return record;
  };
  const issue = (grant, scopes) => {
    const access = randomToken();
    const refresh = randomToken();
    const accessExpiry = Math.min(now() + 60 * 60_000, grant.expiresAt);
    const common = { grantId: grant.id, clientId: grant.clientId, scopes, resource };
    store.put("access", hash(access), { ...common, expiresAt: accessExpiry });
    store.put("refresh", hash(refresh), {
      ...common,
      expiresAt: grant.expiresAt,
      usedAt: null,
    });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor((accessExpiry - now()) / 1000),
      refresh_token: refresh,
      scope: scopes.join(" "),
    };
  };
  const clientsStore = {
    async getClient(id) {
      if (typeof id !== "string" || id.length > 200) return undefined;
      const record = store.get("client", id);
      return record && record.expiresAt > now() ? record.client : undefined;
    },
    async registerClient(input) {
      if (
        input.token_endpoint_auth_method !== "none" ||
        !Array.isArray(input.redirect_uris) ||
        input.redirect_uris.length < 1 ||
        input.redirect_uris.length > 8 ||
        !input.redirect_uris.every(safeRedirect) ||
        (input.client_name && input.client_name.length > 120) ||
        (input.grant_types &&
          input.grant_types.some(
            (type) => !["authorization_code", "refresh_token"].includes(type),
          )) ||
        (input.response_types && input.response_types.some((type) => type !== "code"))
      )
        throw new InvalidClientMetadataError(
          "Only public PKCE clients with safe registered callbacks are supported.",
        );
      const client = {
        client_id: crypto.randomUUID(),
        client_id_issued_at: Math.floor(now() / 1000),
        client_name: input.client_name || "MCP client",
        redirect_uris: [...new Set(input.redirect_uris)],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      };
      store.put("client", client.client_id, {
        client,
        expiresAt: now() + 90 * 24 * 60 * 60_000,
      });
      return client;
    },
  };
  return {
    clientsStore,
    async authorize(client, params, response) {
      requireResource(params.resource);
      if (
        !client.redirect_uris.includes(params.redirectUri) ||
        !/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) ||
        (params.state && params.state.length > 1024)
      )
        throw new InvalidRequestError("Invalid authorization parameters.");
      const scopes = params.scopes?.length
        ? [...new Set(params.scopes)]
        : MCP_SCOPES.filter((scope) => scope !== "runs:publish");
      if (scopes.some((scope) => !MCP_SCOPES.includes(scope)))
        throw new InvalidScopeError("Unsupported scope.");
      const id = randomToken();
      store.put("pending", id, {
        id,
        clientId: client.client_id,
        clientName: client.client_name,
        redirectUris: client.redirect_uris,
        redirectUri: params.redirectUri,
        scopes,
        challenge: params.codeChallenge,
        state: params.state,
        resource,
        expiresAt: now() + 10 * 60_000,
      });
      const url = new URL(consentUrl);
      url.searchParams.set("authorization", id);
      response.redirect(302, url.href);
    },
    async challengeForAuthorizationCode(client, code) {
      return codeRecord(client, code).challenge;
    },
    async exchangeAuthorizationCode(
      client,
      code,
      _verifier,
      redirectUri,
      requestedResource,
    ) {
      requireResource(requestedResource);
      const record = codeRecord(client, code);
      if (redirectUri !== record.redirectUri)
        throw new InvalidGrantError("Registered callback does not match.");
      return store.transaction(() => {
        const current = codeRecord(client, code);
        store.put("code", hash(code), { ...current, usedAt: now() });
        return issue(activeGrant(current.grantId), current.scopes);
      });
    },
    async exchangeRefreshToken(client, token, scopes, requestedResource) {
      requireResource(requestedResource);
      const record = validOpaque(token) ? store.get("refresh", hash(token)) : null;
      if (!record || record.clientId !== client.client_id || record.expiresAt <= now())
        throw new InvalidGrantError("Invalid refresh token.");
      if (record.usedAt) {
        revoke(record.grantId, "refresh_replay");
        throw new InvalidGrantError("Refresh token already used.");
      }
      const grant = activeGrant(record.grantId);
      const narrowed = scopes === undefined ? record.scopes : [...new Set(scopes)];
      if (!narrowed.length || narrowed.some((scope) => !record.scopes.includes(scope)))
        throw new InvalidScopeError("Refresh cannot increase authorization.");
      return store.transaction(() => {
        store.put("refresh", hash(token), { ...record, usedAt: now() });
        return issue(grant, narrowed);
      });
    },
    checkAccessToken(token) {
      const record = validOpaque(token) ? store.get("access", hash(token)) : null;
      if (!record || record.expiresAt <= now() || record.resource !== resource)
        throw new InvalidTokenError("Invalid access token.");
      let grant;
      try {
        grant = activeGrant(record.grantId);
      } catch {
        throw new InvalidTokenError("Authorization expired or revoked.");
      }
      if (!grant.lastUsedAt || now() - grant.lastUsedAt > 60_000)
        store.put("grant", grant.id, { ...grant, lastUsedAt: now() });
      return {
        token,
        clientId: record.clientId,
        scopes: record.scopes,
        expiresAt: Math.floor(record.expiresAt / 1000),
        resource: new URL(resource),
        extra: {
          grant: {
            id: grant.id,
            clientId: grant.clientId,
            scopes: record.scopes,
            projectIds: grant.projectIds,
            accountIds: grant.accountIds,
            connectionIds: grant.connectionIds,
          },
        },
      };
    },
    async verifyAccessToken(token) {
      return this.checkAccessToken(token);
    },
    async revokeToken(client, request) {
      if (!validOpaque(request.token)) return;
      const key = hash(request.token);
      const record = store.get("access", key) || store.get("refresh", key);
      if (record?.clientId === client.client_id) revoke(record.grantId, "token");
    },
    issueCode(pending, grant) {
      const code = randomToken();
      store.put("code", hash(code), {
        clientId: pending.clientId,
        grantId: grant.id,
        scopes: grant.scopes,
        redirectUri: pending.redirectUri,
        challenge: pending.challenge,
        expiresAt: now() + 2 * 60_000,
        usedAt: null,
      });
      return code;
    },
    revoke,
  };
}
