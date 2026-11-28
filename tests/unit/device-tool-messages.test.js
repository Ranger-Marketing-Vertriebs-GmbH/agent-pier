import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  deviceCode,
  deviceToolMessage,
  messageCodes,
} from "../../server/features/devices/device-tool-messages.js";

// What a device tool tells an agent when it refuses (device-tool-messages.js).
const folder = fileURLToPath(new URL("../../server/features/devices/", import.meta.url));
// Every code the modules behind the tools throw, by the quoted literals in them.
function toolCodes() {
  const codes = new Set();
  for (const name of [
    "device-actions.js",
    "device-app-actions.js",
    "device-screen-actions.js",
    "device-input.js",
    "device-mcp.js",
    "host-area.js",
    "device-service.js",
    "device-access.js",
    "device-store.js",
  ])
    for (const [, code] of fs
      .readFileSync(`${folder}${name}`, "utf8")
      .matchAll(/["'`](DEVICE_[A-Z0-9_]+)["'`]/g))
      codes.add(code);
  return [...codes].sort();
}

test("every code a tool can answer has a sentence of its own", () => {
  const codes = toolCodes();
  for (const expected of [
    "DEVICE_FORBIDDEN",
    "DEVICE_HELD",
    "DEVICE_CREATE_FORBIDDEN",
    "DEVICE_ELEMENT_STALE",
    "DEVICE_TEXT_UNSUPPORTED",
    "DEVICE_PATH_OUTSIDE",
    "DEVICE_CALL_TIMEOUT",
    "DEVICE_LIMIT_RUNNING",
    "DEVICE_NAME_TAKEN",
  ])
    assert.ok(codes.includes(expected), expected);
  for (const code of codes) {
    assert.ok(messageCodes.includes(code), code);
    const text = deviceToolMessage({ code });
    assert.ok(text.length > 15 && /[.]$/.test(text), code);
    assert.doesNotMatch(text, /DEVICES?_[A-Z]/, code);
  }
});

test("a sentence says what to do, and carries the detail of its refusal", () => {
  assert.match(deviceToolMessage({ code: "DEVICE_TEXT_UNSUPPORTED" }), /printable ASCII/);
  assert.match(
    deviceToolMessage({ code: "DEVICE_ELEMENT_STALE" }),
    /Call device_ui again/,
  );
  assert.match(deviceToolMessage({ code: "DEVICE_FORBIDDEN" }), /Ask the owner/);
  assert.match(deviceToolMessage({ code: "DEVICE_PATH_OUTSIDE" }), /working folder/);
  assert.equal(
    deviceToolMessage({ code: "DEVICE_FILE_TOO_LARGE", limit: 50 * 2 ** 20 }),
    "The file is larger than the limit for this action. The limit is 50 MB.",
  );
  assert.equal(
    deviceToolMessage({ code: "DEVICE_COMMAND_FAILED", detail: "Error: no such app" }),
    "The device refused this. Detail: Error: no such app",
  );
  assert.match(
    deviceToolMessage({ code: "DEVICE_UNAVAILABLE", reason: "DEVICES_NOT_INSTALLED" }),
    /Reason: DEVICES_NOT_INSTALLED\.$/,
  );
  // A reason that is no code of ours is not repeated.
  assert.doesNotMatch(
    deviceToolMessage({ code: "DEVICE_UNAVAILABLE", reason: "rm -rf" }),
    /rm -rf/,
  );
  assert.equal(
    deviceToolMessage({ code: "DEVICE_NEW_CODE" }),
    "The device call was refused (DEVICE_NEW_CODE).",
  );
  assert.equal(
    deviceToolMessage({ code: "toString" }),
    "The device call was refused (UNKNOWN).",
  );
  assert.equal(deviceToolMessage(undefined), "The device call was refused (UNKNOWN).");
  assert.equal(deviceCode("DEVICE_HELD"), true);
  assert.equal(deviceCode("DEVICES_IN_USE"), true);
  assert.equal(deviceCode("PREVIEW_DISABLED"), false);
  assert.equal(deviceCode(undefined), false);
});
