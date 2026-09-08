import { Router } from "express";
import { randomUUID } from "node:crypto";
import { createAccessStore } from "./access-store.js";
import { createOAuthProvider, MCP_SCOPES } from "./oauth-provider.js";
import { createOAuthRouter } from "./oauth-router.js";
import { problem } from "../../lib/storage.js";

const grantDto = (grant) => ({
  id: grant.id,
  client: { id: grant.clientId, name: grant.clientName },
  scopes: grant.scopes,
  projectIds: grant.projectIds,
  accountIds: grant.accountIds,
  connectionIds: grant.connectionIds,
  createdAt: grant.createdAt,
  expiresAt: grant.expiresAt,
  revokedAt: grant.revokedAt,
  lastUsedAt: grant.lastUsedAt,
});
const normalizeUrl = (value) => {
  if (!value) return null;
  const url = new URL(value);
  if (
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        url.port &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    ) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== "/"
  )
    throw new Error(
      "MCP public URL must be an HTTPS origin or an explicit-port loopback HTTP origin.",
    );
  return url.origin;
};

export function createMcpAccess({
  directory,
  publicUrl,
  now = Date.now,
  onEvent = () => {},
  resolveResources = () => ({ projects: [], accounts: [], connections: [] }),
}) {
  const origin = normalizeUrl(publicUrl);
  const resource = origin ? new URL("/mcp", origin).href : null;
  const store = createAccessStore(directory, now);
  const provider = createOAuthProvider({
    store,
    now,
    resource,
    onEvent,
    consentUrl: origin ? new URL("/settings/mcp", origin).href : null,
  });
  const resources = () => {
    const resolved = resolveResources();
    return Object.fromEntries(
      ["projects", "accounts", "connections"].map((kind) => [
        kind,
        (resolved[kind] || [])
          .filter((item) => typeof item.id === "string" && item.id !== "*")
          .map(({ id, name }) => ({ id, name: String(name || id).slice(0, 200) })),
      ]),
    );
  };
  const pending = (id) => {
    const record =
      typeof id === "string" && id.length === 43 ? store.get("pending", id) : null;
    if (!record) throw problem("Authorization request not found.", 404);
    if (!origin || record.resource !== resource || record.expiresAt <= now())
      throw problem("Authorization request expired.", 410);
    return record;
  };
  const callback = (record, values) => {
    const url = new URL(record.redirectUri);
    for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
    if (record.state !== undefined) url.searchParams.set("state", record.state);
    return { redirectUrl: url.href };
  };
  return {
    publicRouter: origin ? createOAuthRouter(provider, origin) : Router(),
    verifyAccessToken: (token) => provider.verifyAccessToken(token),
    checkAccessToken: (token) => provider.checkAccessToken(token),
    status: () => ({
      available: Boolean(origin),
      mcpUrl: resource,
      scopes: MCP_SCOPES,
      resources: resources(),
    }),
    listGrants({ offset = 0, limit = 20 } = {}) {
      offset = Math.max(0, Math.min(100000, Number.parseInt(offset, 10) || 0));
      limit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 20));
      const grants = store.list("grant");
      return {
        grants: grants.slice(offset, offset + limit).map(grantDto),
        total: grants.length,
        offset,
        limit,
      };
    },
    consent(id) {
      const record = pending(id);
      return {
        id,
        client: {
          id: record.clientId,
          name: record.clientName,
          redirectUris: record.redirectUris,
        },
        requestedScopes: record.scopes,
        expiresAt: record.expiresAt,
      };
    },
    approve(id, selection) {
      const record = pending(id);
      const choices = resources();
      const scopes = selection?.scopes;
      if (
        !Array.isArray(scopes) ||
        !scopes.length ||
        scopes.length > MCP_SCOPES.length ||
        scopes.some((scope) => !record.scopes.includes(scope))
      )
        throw problem("Select only requested scopes.", 400);
      const allowlists = {};
      for (const [key, kind] of [
        ["projectIds", "projects"],
        ["accountIds", "accounts"],
        ["connectionIds", "connections"],
      ]) {
        const values = selection?.[key];
        if (
          !Array.isArray(values) ||
          values.length > 1000 ||
          values.some(
            (id) =>
              typeof id !== "string" ||
              id === "*" ||
              !choices[kind].some((item) => item.id === id),
          )
        )
          throw problem("Select only available resources.", 400);
        allowlists[key] = [...new Set(values)];
      }
      const grantId = randomUUID();
      const result = store.transaction(() => {
        const grant = {
          id: grantId,
          clientId: record.clientId,
          clientName: record.clientName,
          scopes: [...new Set(scopes)],
          ...allowlists,
          resource,
          createdAt: now(),
          expiresAt: now() + 30 * 24 * 60 * 60_000,
          revokedAt: null,
          lastUsedAt: null,
        };
        store.put("grant", grant.id, grant);
        const code = provider.issueCode(record, grant);
        store.remove("pending", id);
        return callback(record, { code });
      });
      onEvent({
        action: "mcp.accepted",
        grantId,
        clientId: record.clientId,
        resourceCount: Object.values(allowlists).reduce(
          (count, ids) => count + ids.length,
          0,
        ),
      });
      return result;
    },
    deny(id) {
      const record = pending(id);
      store.remove("pending", id);
      onEvent({ action: "mcp.denied", clientId: record.clientId });
      return callback(record, { error: "access_denied" });
    },
    revoke(id) {
      if (!store.get("grant", id)) throw problem("Grant not found.", 404);
      provider.revoke(id, "owner");
      return { revoked: true };
    },
    close: () => store.close(),
  };
}
