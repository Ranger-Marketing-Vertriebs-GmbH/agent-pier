import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import express from "express";
import { createOAuthRouter } from "../../server/features/mcp/oauth-router.js";
import { authorizeMcpTransport } from "../../server/features/mcp/http-transport.js";

const remoteHost = "pier.tailnet.example";

/** The OAuth router behind the MCP transport check, as the application mounts it. */
async function fixture(t, limits) {
  const registered = [];
  const provider = {
    revokeToken: async () => {},
    clientsStore: {
      getClient: async () => undefined,
      registerClient: async (client) => {
        registered.push(client);
        return { ...client, client_id: `client-${registered.length}` };
      },
    },
  };
  const app = express();
  let port;
  app.use((req, res, next) => {
    try {
      authorizeMcpTransport(req, { port, remoteUrl: `https://${remoteHost}` });
    } catch (error) {
      return res.status(error.status || 403).json({ error: error.message });
    }
    next();
  });
  app.use(createOAuthRouter(provider, `https://${remoteHost}`, limits));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = server.address().port;
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  // `device`: a tailnet address as Tailscale Serve names it; without one, a local client.
  const register = (device) =>
    new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/register",
          method: "POST",
          headers: {
            host: device ? remoteHost : `127.0.0.1:${port}`,
            "content-type": "application/json",
            ...(device && { "x-forwarded-for": device }),
          },
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () =>
            resolve({ status: response.statusCode, body: JSON.parse(body || "null") }),
          );
        },
      );
      request.on("error", reject);
      request.end(
        JSON.stringify({
          redirect_uris: ["http://127.0.0.1:49152/callback"],
          token_endpoint_auth_method: "none",
        }),
      );
    });
  return { register, registered };
}

test("each tailnet device and the local machine have a registration window of their own", async (t) => {
  const { register, registered } = await fixture(t);
  for (let i = 0; i < 20; i++) assert.equal((await register("100.64.0.1")).status, 201);
  const limited = await register("100.64.0.1");
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "too_many_requests");
  // The device that used up its window keeps nobody else from registering.
  assert.equal((await register("100.64.0.2")).status, 201);
  assert.equal((await register("fd7a:115c:a1e0::2")).status, 201);
  assert.equal((await register()).status, 201);
  assert.equal(registered.length, 23);
});

test("registrations of all sources together stay below a ceiling", async (t) => {
  const { register, registered } = await fixture(t, { perSource: 3, total: 5 });
  // A device beyond its own window does not use up the ceiling.
  for (let i = 0; i < 6; i++) await register("100.64.0.1");
  assert.equal(registered.length, 3);
  assert.equal((await register("100.64.0.2")).status, 201);
  assert.equal((await register("100.64.0.3")).status, 201);
  const limited = await register("100.64.0.4");
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "too_many_requests");
  assert.equal(registered.length, 5);
});
