import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mcpCliOAuthCallbackRoutes } from "../../server/http/routes/mcp-cli-oauth.js";

/** The callback route with `trustBranch` set as the security layer would. */
async function serve(t, { trustBranch, logins, barrier }) {
  const app = express();
  app.use((req, _res, next) => {
    req.trustBranch = trustBranch;
    next();
  });
  app.use(
    "/api",
    mcpCliOAuthCallbackRoutes({ codexMcpLogins: logins, mutationBarrier: barrier }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (target) =>
    fetch(`http://127.0.0.1:${server.address().port}${target}`, { redirect: "manual" });
}

const path = "/api/mcp-servers/cli-oauth/callback/SEG?code=c&state=s";

test("a plain network host never completes a login", async (t) => {
  let completed = 0;
  const get = await serve(t, {
    trustBranch: "network",
    logins: { complete: async () => completed++ },
  });
  const response = await get(path);
  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    "/accounts?oauth=error&reason=plain-http-remote",
  );
  assert.equal(completed, 0);
});

test("an exclusive backup or restore consumes no state", async (t) => {
  let completed = 0;
  const get = await serve(t, {
    trustBranch: "local",
    logins: { complete: async () => completed++ },
    barrier: { exclusive: true },
  });
  const response = await get(path);
  assert.equal(
    response.headers.get("location"),
    "/accounts?oauth=error&reason=unavailable",
  );
  assert.equal(completed, 0);
});

test("the full received path and query reach the login service", async (t) => {
  const seen = [];
  const get = await serve(t, {
    trustBranch: "local",
    logins: {
      complete: async (received) => {
        seen.push(received);
        return { serverId: "s1", accountId: "a1", result: "connected" };
      },
    },
  });
  const response = await get(path);
  assert.deepEqual(seen, [path]);
  assert.equal(
    response.headers.get("location"),
    "/accounts?oauth=connected&server=s1&cli=codex&account=a1",
  );
});
