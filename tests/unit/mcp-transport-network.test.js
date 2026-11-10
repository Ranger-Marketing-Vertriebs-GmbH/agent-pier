import test from "node:test";
import assert from "node:assert/strict";
import { authorizeMcpTransport } from "../../server/features/mcp/http-transport.js";
const config = {
  port: 4380,
  remoteUrl: null,
  network: { enabled: true, bind: "0.0.0.0", hosts: [] },
  networkHosts: new Set(["192.168.1.20:4380"]),
};
const request = (headers = {}, remoteAddress = "192.168.1.55") => ({
  headers: { host: "192.168.1.20:4380", ...headers },
  method: "POST",
  path: "/mcp",
  socket: { remoteAddress },
});
test("MCP transport accepts listed network hosts and rejects others", () => {
  assert.equal(authorizeMcpTransport(request(), config), undefined);
  assert.throws(() => authorizeMcpTransport(request({ host: "10.0.0.9:4380" }), config), {
    status: 403,
  });
  assert.throws(
    () => authorizeMcpTransport(request({ "tailscale-user-login": "x" }), config),
    {
      status: 403,
    },
  );
  assert.throws(
    () =>
      authorizeMcpTransport(request(), {
        ...config,
        network: { ...config.network, enabled: false },
      }),
    { status: 403 },
  );
});

test("the Tailscale host serves MCP only to a signed-in tailnet device", () => {
  const remote = { ...config, remoteUrl: "https://agentpier.tail1234.ts.net" };
  const serve = (headers = {}, path = "/mcp") => ({
    headers: { host: "agentpier.tail1234.ts.net", ...headers },
    method: "POST",
    path,
    socket: { remoteAddress: "127.0.0.1" },
  });
  const member = { "tailscale-user-login": "owner@example.com" };
  for (const path of ["/mcp", "/register", "/token", "/authorize", "/revoke"]) {
    assert.equal(authorizeMcpTransport(serve(member, path), remote), undefined);
    // No identity: a tagged device, or anything that is not Tailscale Serve.
    assert.throws(() => authorizeMcpTransport(serve({}, path), remote), { status: 403 });
    assert.throws(
      () => authorizeMcpTransport(serve({ "tailscale-user-login": " " }, path), remote),
      { status: 403 },
    );
    // Funnel traffic comes from the public internet, with or without a login header.
    for (const headers of [
      { "tailscale-funnel-request": "?1" },
      { ...member, "tailscale-funnel-request": "?1" },
    ])
      assert.throws(() => authorizeMcpTransport(serve(headers, path), remote), {
        status: 403,
      });
  }
  // The origin of the remote host still has to match for a member.
  assert.throws(
    () =>
      authorizeMcpTransport(serve({ ...member, origin: "https://evil.example" }), remote),
    { status: 403 },
  );
  // The local branch is unchanged and takes no identity.
  assert.equal(
    authorizeMcpTransport({ ...serve(), headers: { host: "127.0.0.1:4380" } }, remote),
    undefined,
  );
});
