import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeNetworkConfig,
  detectNetworkAddresses,
  allowedNetworkHosts,
  networkUrls,
  readNetworkConfig,
  writeNetworkConfig,
} from "../../server/features/remote/network-access.js";

test("missing network block is disabled with safe defaults", () => {
  assert.deepEqual(normalizeNetworkConfig(undefined), {
    enabled: false,
    bind: "0.0.0.0",
    hosts: [],
  });
});
test("network block validates bind and host entries", () => {
  assert.deepEqual(
    normalizeNetworkConfig({ enabled: true, bind: "::", hosts: ["Agentpier.Home.arpa"] }),
    { enabled: true, bind: "::", hosts: ["agentpier.home.arpa"] },
  );
  assert.equal(
    normalizeNetworkConfig({ enabled: true, bind: "0.0.0.0" }).bind,
    "0.0.0.0",
  );
  for (const bind of [
    "0.0.0.0/8",
    "example.com",
    "",
    5,
    "127.0.0.1 ",
    "192.168.1.5",
    "127.0.0.1",
    "::1",
  ])
    assert.throws(() => normalizeNetworkConfig({ enabled: true, bind, hosts: [] }), {
      status: 400,
    });
  for (const host of ["http://a", "a/b", "a:4380", "bad host", "x".repeat(254), ""])
    assert.throws(() => normalizeNetworkConfig({ enabled: true, hosts: [host] }), {
      status: 400,
    });
  assert.throws(
    () => normalizeNetworkConfig({ enabled: true, hosts: Array(21).fill("a.example") }),
    { status: 400 },
  );
  assert.throws(() => normalizeNetworkConfig({ enabled: "yes" }), { status: 400 });
});
test("detected addresses exclude internal interfaces and zone ids", () => {
  const detected = detectNetworkAddresses({
    interfaces: () => ({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      en0: [
        { address: "192.168.1.20", family: "IPv4", internal: false },
        { address: "fe80::1%en0", family: "IPv6", internal: false, scopeid: 4 },
        { address: "2001:db8::5", family: "IPv6", internal: false, scopeid: 0 },
      ],
    }),
    hostname: () => "MacMini",
  });
  assert.deepEqual(detected, {
    addresses: ["192.168.1.20"],
    hostname: "macmini",
  });
});
test("only private ranges are detected, Tailscale and public addresses are dropped", () => {
  const detected = detectNetworkAddresses({
    interfaces: () => ({
      en0: [
        { address: "172.20.0.9", family: "IPv4", internal: false },
        { address: "10.1.2.3", family: "IPv4", internal: false },
        { address: "203.0.113.5", family: "IPv4", internal: false },
        { address: "172.32.0.1", family: "IPv4", internal: false },
        { address: "fd12::1", family: "IPv6", internal: false },
      ],
      tailscale0: [
        { address: "100.109.130.23", family: "IPv4", internal: false },
        { address: "fd7a:115c:a1e0::1", family: "IPv6", internal: false },
      ],
    }),
    hostname: () => "macmini",
  });
  assert.deepEqual(detected.addresses, ["172.20.0.9", "10.1.2.3", "fd12::1"]);
});
test("hostname .local suffix is stripped once and re-added as separate candidate", () => {
  const detected = detectNetworkAddresses({
    interfaces: () => ({}),
    hostname: () => "MacMini.local",
  });
  assert.deepEqual(detected, {
    addresses: [],
    hostname: "macmini",
  });
  const network = { enabled: true, bind: "0.0.0.0", hosts: [] };
  const hosts = [...allowedNetworkHosts(network, 4380, detected)];
  assert.deepEqual(hosts, ["macmini:4380", "macmini.local:4380"]);
  assert.equal(hosts.filter((h) => h.includes("macmini")).length, 2);
});
test("a dotted host name never gets a .local candidate appended", () => {
  const detected = detectNetworkAddresses({
    interfaces: () => ({}),
    hostname: () => "MacMini.lan",
  });
  assert.equal(detected.hostname, "macmini.lan");
  assert.deepEqual(
    [
      ...allowedNetworkHosts(
        { enabled: true, bind: "0.0.0.0", hosts: [] },
        4380,
        detected,
      ),
    ],
    ["macmini.lan:4380"],
  );
});
test("host labels are limited to 63 characters", () => {
  const label = "a".repeat(63);
  assert.deepEqual(
    normalizeNetworkConfig({ enabled: true, hosts: [`${label}.example`] }).hosts,
    [`${label}.example`],
  );
  assert.throws(
    () => normalizeNetworkConfig({ enabled: true, hosts: [`a${label}.example`] }),
    { status: 400 },
  );
});
test("allowed hosts combine list, host name and addresses with the port", () => {
  const network = { enabled: true, bind: "0.0.0.0", hosts: ["agentpier.home.arpa"] };
  const detected = { addresses: ["192.168.1.20", "fd12::1"], hostname: "macmini" };
  assert.deepEqual(
    [...allowedNetworkHosts(network, 4380, detected)],
    [
      "agentpier.home.arpa:4380",
      "macmini:4380",
      "macmini.local:4380",
      "192.168.1.20:4380",
      "[fd12::1]:4380",
    ],
  );
  assert.deepEqual(
    [...allowedNetworkHosts({ ...network, enabled: false }, 4380, detected)],
    [],
  );
  assert.deepEqual(networkUrls(network, 4380, detected), [
    "http://agentpier.home.arpa:4380",
    "http://macmini:4380",
    "http://macmini.local:4380",
    "http://192.168.1.20:4380",
    "http://[fd12::1]:4380",
  ]);
});
test("config file round trip keeps unrelated keys and private mode", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "network-config-"));
  try {
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ port: 4390, remoteUrl: "https://x.ts.net", ownerLogin: "o@x" }),
    );
    assert.deepEqual(readNetworkConfig(dataDir).network, {
      enabled: false,
      bind: "0.0.0.0",
      hosts: [],
    });
    writeNetworkConfig(dataDir, { enabled: true, bind: "0.0.0.0", hosts: ["a.example"] });
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
    assert.deepEqual(saved, {
      port: 4390,
      remoteUrl: "https://x.ts.net",
      ownerLogin: "o@x",
      network: { enabled: true, bind: "0.0.0.0", hosts: ["a.example"] },
    });
    assert.equal(fs.statSync(path.join(dataDir, "config.json")).mode & 0o777, 0o600);
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ network: 5 }));
    assert.throws(() => readNetworkConfig(dataDir), { status: 400 });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
