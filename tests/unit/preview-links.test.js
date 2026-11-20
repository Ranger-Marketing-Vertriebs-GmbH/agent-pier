import assert from "node:assert/strict";
import test from "node:test";
import {
  loopbackUnderTailscale,
  previewHref,
} from "../../web/features/previews/preview-links.js";

test("previewHref keeps the page's host name", () => {
  assert.equal(
    previewHref(
      { slot: 47100, path: "/admin" },
      { protocol: "https:", hostname: "box.tail1.ts.net" },
    ),
    "https://box.tail1.ts.net:47100/admin",
  );
  assert.equal(
    previewHref({ slot: 47101 }, { protocol: "http:", hostname: "::1" }),
    "http://[::1]:47101/",
  );
  assert.equal(
    previewHref({ slot: 47101 }, { protocol: "http:", hostname: "[::1]" }),
    "http://[::1]:47101/",
  );
});

test("loopbackUnderTailscale flags dead links at 127.0.0.1 under Tailscale only", () => {
  const serve = { registered: [47200], failed: [], commands: [] };
  const at = (hostname) => ({ protocol: "http:", hostname });
  assert.equal(loopbackUnderTailscale(serve, at("127.0.0.1")), true);
  assert.equal(loopbackUnderTailscale(serve, at("localhost")), true);
  assert.equal(loopbackUnderTailscale(serve, at("box.tail1.ts.net")), false);
  assert.equal(loopbackUnderTailscale(null, at("127.0.0.1")), false);
  assert.equal(
    loopbackUnderTailscale({ ...serve, skipped: "network" }, at("127.0.0.1")),
    false,
  );
});
