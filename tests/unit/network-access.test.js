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
  for (const bind of ["0.0.0.0/8", "example.com", "", 5, "127.0.0.1 "])
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
    addresses: ["192.168.1.20", "2001:db8::5"],
    hostname: "macmini",
  });
});
test("allowed hosts combine list, host name and addresses with the port", () => {
  const network = { enabled: true, bind: "0.0.0.0", hosts: ["agentpier.home.arpa"] };
  const detected = { addresses: ["192.168.1.20", "2001:db8::5"], hostname: "macmini" };
  assert.deepEqual(
    [...allowedNetworkHosts(network, 4380, detected)],
    [
      "agentpier.home.arpa:4380",
      "macmini:4380",
      "macmini.local:4380",
      "192.168.1.20:4380",
      "[2001:db8::5]:4380",
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
    "http://[2001:db8::5]:4380",
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
