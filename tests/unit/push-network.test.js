import test from "node:test";
import assert from "node:assert/strict";
const module = await import("../../server/features/notifications/push-network.js").catch(
  () => ({}),
);
test("push DNS answers cannot connect to local private multicast or mapped addresses", () => {
  assert.equal(typeof module.publicPushAddress, "function");
  for (const ip of [
    "127.0.0.1",
    "10.5.0.2",
    "172.16.3.4",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.1.2",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
    "bad",
  ])
    assert.equal(module.publicPushAddress(ip), false, ip);
  for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
    assert.equal(module.publicPushAddress(ip), true, ip);
});
