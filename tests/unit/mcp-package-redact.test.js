import test from "node:test";
import assert from "node:assert/strict";
import { pathRedactor } from "../../server/features/mcp-packages/package-install-job.js";

test("path redaction replaces the data and home dirs only at a path boundary", () => {
  const redact = pathRedactor("/data", "/root");
  assert.equal(
    redact("npm error 404 Not Found - GET https://registry.npmjs.org/data-x"),
    "npm error 404 Not Found - GET https://registry.npmjs.org/data-x",
  );
  assert.equal(redact("installed /rootkit"), "installed /rootkit");
  assert.equal(
    redact("GET https://registry.npmjs.org/data/x"),
    "GET https://registry.npmjs.org/data/x",
  );
  assert.equal(redact("wrote /data/x"), "wrote <data>/x");
  assert.equal(redact("cache /root/y"), "cache ~/y");
  assert.equal(redact("at /data"), "at <data>");
  assert.equal(
    redact(`"/data" '/root' (/data/z) [/root], /data: /root\n`),
    `"<data>" '~' (<data>/z) [~], <data>: ~\n`,
  );
});

test("path redaction prefers the longer dir when one contains the other", () => {
  const redact = pathRedactor("/root/data", "/root");
  assert.equal(redact("/root/data/a /root/b"), "<data>/a ~/b");
});
