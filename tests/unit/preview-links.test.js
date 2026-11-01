import assert from "node:assert/strict";
import test from "node:test";
import { previewHref } from "../../web/features/previews/preview-links.js";

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
