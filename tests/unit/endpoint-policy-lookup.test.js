import test from "node:test";
import assert from "node:assert/strict";
import { policyLookup } from "../../server/features/providers/endpoint-address.js";

const answer = (addresses) => (_host, _options, callback) => callback(null, addresses);
const run = (protocol, addresses, options = { all: true }) =>
  new Promise((resolve) =>
    policyLookup(protocol, answer(addresses))("upstream.test", options, (...args) =>
      resolve(args),
    ),
  );

test("one forbidden address in a mixed answer refuses the whole lookup", async () => {
  const [error] = await run("https:", [
    { address: "127.0.0.1", family: 4 },
    { address: "0.0.0.0", family: 4 },
  ]);
  assert.equal(error.code, "EADDRNOTALLOWED");
  assert.equal(error.reason, "notAllowed");
  assert.equal(error.adapterKind, "network");
});

test("http refuses a mixed local and public answer; https accepts it", async () => {
  const mixed = [
    { address: "10.0.0.5", family: 4 },
    { address: "8.8.8.8", family: 4 },
  ];
  assert.equal((await run("http:", mixed))[0].code, "EADDRNOTALLOWED");
  const [error, addresses] = await run("https:", mixed);
  assert.equal(error, null);
  assert.deepEqual(addresses, mixed);
});

test("IPv4-mapped and NAT64 answers classify by their embedded address", async () => {
  const refused = [
    ["http:", "::ffff:8.8.8.8", 6],
    ["https:", "::ffff:0.0.0.0", 6],
    ["http:", "64:ff9b::a00:5", 6],
    ["https:", "64:ff9b::e000:1", 6],
  ];
  for (const [protocol, address, family] of refused)
    assert.equal(
      (await run(protocol, [{ address, family }]))[0]?.code,
      "EADDRNOTALLOWED",
      `${protocol} ${address}`,
    );
  const allowed = [
    ["http:", "::ffff:127.0.0.1", 6],
    ["https:", "64:ff9b::808:808", 6],
  ];
  for (const [protocol, address, family] of allowed)
    assert.equal((await run(protocol, [{ address, family }]))[0], null);
});

test("single-address callers receive the first checked address; empty answers fail", async () => {
  const [error, address, family] = await run(
    "http:",
    [
      { address: "::1", family: 6 },
      { address: "127.0.0.1", family: 4 },
    ],
    {},
  );
  assert.equal(error, null);
  assert.equal(address, "::1");
  assert.equal(family, 6);
  assert.equal((await run("https:", []))[0].code, "EADDRNOTALLOWED");
});
