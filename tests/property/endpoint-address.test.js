import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import {
  classifyAddress,
  resolveEndpointTarget,
} from "../../server/features/providers/endpoint-address.js";

const octet = fc.integer({ min: 0, max: 255 });
const ipv4 = fc.tuple(octet, octet, octet, octet).map((parts) => parts.join("."));
const local = (ip) =>
  ["loopback", "private", "linkLocal", "cgnat"].includes(classifyAddress(ip));
const hexMapped = (ip) => {
  const [a, b, c, d] = ip.split(".").map(Number);
  return `::ffff:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
};

test("known ranges classify correctly", () => {
  for (const [ip, kind] of [
    ["127.0.0.1", "loopback"],
    ["::1", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.1", "private"],
    ["169.254.1.1", "linkLocal"],
    ["fe80::1", "linkLocal"],
    ["fd12::1", "private"],
    ["100.64.0.1", "cgnat"],
    ["100.127.255.255", "cgnat"],
    ["100.128.0.1", "public"],
    ["8.8.8.8", "public"],
    ["0.0.0.0", "forbidden"],
    ["::", "forbidden"],
    ["224.0.0.1", "forbidden"],
    ["255.255.255.255", "forbidden"],
    ["ff02::1", "forbidden"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:8.8.8.8", "public"],
    ["2001:4860::8888", "public"],
  ])
    assert.equal(classifyAddress(ip), kind, ip);
});

test("IPv6 edge cases: hex-mapped, zero-compressed, zone ids, brackets, garbage", () => {
  for (const [ip, kind] of [
    ["::ffff:7f00:1", "loopback"],
    ["::FFFF:7F00:1", "loopback"],
    ["0:0:0:0:0:ffff:7f00:1", "loopback"],
    ["::ffff:0:0", "forbidden"],
    ["::ffff:a00:1", "private"],
    ["::ffff:808:808", "public"],
    ["::ffff:e000:1", "forbidden"],
    ["fe80::1%en0", "linkLocal"],
    ["[::1]", "loopback"],
    ["[::ffff:7f00:1]", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["::2", "forbidden"],
    ["64:ff9b::7f00:1", "loopback"],
    ["not-an-ip", "forbidden"],
    ["", "forbidden"],
  ])
    assert.equal(classifyAddress(ip), kind, ip);
  assert.equal(new URL("http://[::ffff:127.0.0.1]/").hostname, "[::ffff:7f00:1]");
});

test("mapped IPv6 always classifies like its IPv4 address", () => {
  check(
    fc.property(
      ipv4,
      (ip) =>
        classifyAddress(`::ffff:${ip}`) === classifyAddress(ip) &&
        classifyAddress(hexMapped(ip)) === classifyAddress(ip),
    ),
  );
});

test("http never reaches a public address; https may", async () => {
  await check(
    fc.asyncProperty(ipv4, async (ip) => {
      const lookup = async () => [{ address: ip, family: 4 }];
      const kind = classifyAddress(ip);
      const http = resolveEndpointTarget("http://model.example:8080/v1", { lookup });
      if (local(ip)) assert.equal((await http).address, ip);
      else await assert.rejects(http, { status: 400 });
      const https = resolveEndpointTarget("https://model.example/v1", { lookup });
      if (kind === "forbidden") await assert.rejects(https, { status: 400 });
      else assert.equal((await https).address, ip);
    }),
  );
});

test("one public address among private ones blocks http", async () => {
  const lookup = async () => [
    { address: "10.0.0.2", family: 4 },
    { address: "8.8.8.8", family: 4 },
  ];
  await assert.rejects(resolveEndpointTarget("http://mixed.example/v1", { lookup }), {
    status: 400,
  });
});

test("IP literals do not call DNS", async () => {
  const lookup = async () => assert.fail("lookup called");
  assert.equal(
    (await resolveEndpointTarget("http://[::1]:11434/v1", { lookup })).address,
    "::1",
  );
  assert.equal(
    (await resolveEndpointTarget("http://192.168.0.5/v1", { lookup })).address,
    "192.168.0.5",
  );
  await assert.rejects(resolveEndpointTarget("http://[::ffff:8.8.8.8]/v1", { lookup }), {
    status: 400,
  });
  assert.equal(
    (await resolveEndpointTarget("http://[::ffff:127.0.0.1]/v1", { lookup })).address,
    "::ffff:7f00:1",
  );
});

test("lookup failures and empty results become endpointUrlNotAllowed", async () => {
  await assert.rejects(
    resolveEndpointTarget("http://nx.example/v1", {
      lookup: async () => {
        throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      },
    }),
    (error) => error.status === 400 && error.code !== "ENOTFOUND",
  );
  await assert.rejects(
    resolveEndpointTarget("http://empty.example/v1", { lookup: async () => [] }),
    { status: 400 },
  );
});

test("lookup is called with all and verbatim and the first address is returned", async () => {
  let args;
  const lookup = async (...rest) => {
    args = rest;
    return [
      { address: "10.0.0.2", family: 4 },
      { address: "fd00::2", family: 6 },
    ];
  };
  const target = await resolveEndpointTarget("http://box.local:1234/v1", { lookup });
  assert.deepEqual(args, ["box.local", { all: true, verbatim: true }]);
  assert.deepEqual(target, { hostname: "box.local", address: "10.0.0.2", family: 4 });
});
