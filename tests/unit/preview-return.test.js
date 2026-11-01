import test from "node:test";
import assert from "node:assert/strict";
import { previewReturn } from "../../web/features/login/preview-return.js";

const local = { protocol: "http:", hostname: "localhost" };

test("returns to the preview on the same host name only", () => {
  assert.equal(
    previewReturn("?preview=47100&path=%2Fadmin", local),
    "http://localhost:47100/admin",
  );
  for (const bad of [
    "?preview=80&path=/",
    "?preview=47100&path=%2F%2Fevil.com",
    "?preview=x",
  ])
    assert.equal(previewReturn(bad, local), null);
});

test("refuses control characters, backslashes, odd ports and relative paths", () => {
  for (const bad of [
    "",
    "?path=/",
    "?preview=65536&path=/",
    "?preview=1023&path=/",
    "?preview=47100.5&path=/",
    "?preview=047100&path=/",
    "?preview=47100&path=admin",
    "?preview=47100&path=%2F%5Cevil.com",
    "?preview=47100&path=%2Fa%0Ab",
    "?preview=47100&path=%2Fa%7Fb",
  ])
    assert.equal(previewReturn(bad, local), null, bad);
  assert.equal(previewReturn("?preview=47100&path=%2Fa%0Ab", local), null);
  assert.equal(
    previewReturn("?preview=47100&path=/x", { protocol: "javascript:", hostname: "a" }),
    null,
  );
});

test("keeps the query of the preview path and the Tailscale host name", () => {
  assert.equal(
    previewReturn("?preview=47101&path=%2Fa%3Fb%3D1%23c", {
      protocol: "https:",
      hostname: "box.tail.ts.net",
    }),
    "https://box.tail.ts.net:47101/a?b=1#c",
  );
  assert.equal(previewReturn("?preview=47101", local), "http://localhost:47101/");
  assert.equal(
    previewReturn("?preview=47101&path=%2F", { protocol: "http:", hostname: "[::1]" }),
    "http://[::1]:47101/",
  );
});
