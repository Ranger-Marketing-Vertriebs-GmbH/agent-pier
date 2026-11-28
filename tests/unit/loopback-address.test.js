import test from "node:test";
import assert from "node:assert/strict";
import { isLoopbackAddress } from "../helpers/loopback-address.js";

// The Android device contract (tests/integration/android-devices-contract.test.js)
// asserts that every listener of the emulator and adb is on loopback. It runs only
// where a real SDK is, so the predicate is tested here against what macOS `lsof` and
// Linux `ss` print.
test("loopback addresses are recognised in every form the tools print", () => {
  for (const address of [
    "127.0.0.1",
    "127.0.0.53",
    "127.255.255.255",
    "::1",
    "[::1]",
    // Linux `ss` for a dual-stack socket bound to IPv4 loopback.
    "::ffff:127.0.0.1",
    "[::ffff:127.0.0.1]",
    "::FFFF:127.0.0.1",
    "::ffff:127.1.2.3",
  ])
    assert.equal(isLoopbackAddress(address), true, address);
});

test("wildcards and every other address are not loopback", () => {
  for (const address of [
    "*",
    "0.0.0.0",
    "::",
    "[::]",
    "::ffff:0.0.0.0",
    "[::ffff:0.0.0.0]",
    "192.168.1.5",
    "10.0.0.1",
    "128.0.0.1",
    "1127.0.0.1",
    "127.0.0.1.5",
    "127.0.0",
    "127.0.0.256",
    "::ffff:192.168.1.5",
    "::ffff:127.0.0.1:80",
    "fe80::1",
    "::2",
    "[::1",
    "localhost",
    "",
    undefined,
    null,
  ])
    assert.equal(isLoopbackAddress(address), false, String(address));
});
