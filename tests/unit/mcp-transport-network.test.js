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
