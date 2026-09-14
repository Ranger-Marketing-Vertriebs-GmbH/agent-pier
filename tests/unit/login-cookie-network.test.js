import test from "node:test";
import assert from "node:assert/strict";
import { cookieOptions } from "../../server/http/login.js";
const config = {
  port: 4380,
  remoteUrl: "https://host.example.ts.net:8443",
  network: { enabled: true, bind: "0.0.0.0", hosts: [] },
  networkHosts: new Set(["192.168.1.20:4380"]),
};
const request = (host, remoteAddress, encrypted = false) => ({
  headers: { host },
  socket: { remoteAddress, encrypted },
});
test("cookies are Secure only for the HTTPS Tailscale host, never for plain network hosts", () => {
  assert.equal(
    cookieOptions(request("host.example.ts.net:8443", "127.0.0.1"), config).secure,
    true,
  );
  assert.equal(
    cookieOptions(request("192.168.1.20:4380", "192.168.1.55"), config).secure,
    false,
  );
  assert.equal(
    cookieOptions(request("127.0.0.1:4380", "127.0.0.1"), config).secure,
    false,
  );
  assert.equal(
    cookieOptions(request("192.168.1.20:4380", "192.168.1.55", true), config).secure,
    true,
  );
  assert.deepEqual(
    Object.keys(cookieOptions(request("127.0.0.1:4380", "127.0.0.1"), config)).sort(),
    ["httpOnly", "path", "sameSite", "secure"],
  );
});
