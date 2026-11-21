// Network mode's extra hosts (W8 B11): one rule for the browser and the server, and a
// refusal that names the host.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { networkHost } from "../../server/lib/network-host.js";
import { normalizeNetworkConfig } from "../../server/lib/network-config.js";

test("names and IP addresses pass, lower-cased; anything with scheme, port or path fails", () => {
  for (const [input, stored] of [
    ["Agentpier.Home.arpa", "agentpier.home.arpa"],
    [" my.host.example ", "my.host.example"],
    ["192.168.1.20", "192.168.1.20"],
    ["fd00::1", "fd00::1"],
    ["macmini", "macmini"],
  ])
    assert.equal(networkHost(input), stored, input);
  for (const input of [
    "http://a",
    "a/b",
    "a:4380",
    "bad host",
    "bad host:8080",
    "x".repeat(254),
    "",
    "[fd00::1]",
    "fe80::1%en0",
    null,
  ])
    assert.equal(networkHost(input), null, String(input));
});

test("the browser's rule agrees with Node's IP check for addresses", () => {
  for (const address of ["10.0.0.1", "0.0.0.0", "::", "::ffff:10.0.0.1", "1:2:3::8"])
    assert.equal(Boolean(networkHost(address)), net.isIP(address) !== 0, address);
});

test("the server's refusal names the host that is wrong", () => {
  assert.throws(
    () =>
      normalizeNetworkConfig({ enabled: true, hosts: ["good.example", "bad host:8080"] }),
    (error) => error.status === 400 && error.message.includes("bad host:8080"),
  );
});
