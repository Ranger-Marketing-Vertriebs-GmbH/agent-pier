import test from "node:test";
import assert from "node:assert/strict";
import { setupAllowed } from "../../server/http/login.js";

const config = {
  port: 4380,
  remoteUrl: "https://host.example.ts.net",
  ownerLogin: "owner@example.test",
};
const request = (host, trustBranch, headers = {}) => ({
  headers: { host, ...headers },
  socket: { remoteAddress: "127.0.0.1" },
  trustBranch,
});
const tailnet = (login) =>
  request("host.example.ts.net", "tailscale", { "tailscale-user-login": login });

test("the owner account is created locally or by the owner's own Tailscale login", () => {
  assert.equal(setupAllowed(request("127.0.0.1:4380", "local"), config, true), true);
  assert.equal(setupAllowed(tailnet("owner@example.test"), config, true), true);
  assert.equal(setupAllowed(tailnet("anna@example.test"), config, false), false);
  assert.equal(
    setupAllowed(tailnet("owner@example.test"), { ...config, ownerLogin: null }, false),
    false,
  );
});

test("plain network setup stays open only while no user exists", () => {
  const lan = { ...request("192.168.1.20:4380", "network"), socket: {} };
  assert.equal(setupAllowed(lan, config, false), true);
  assert.equal(setupAllowed(lan, config, true), false);
});
