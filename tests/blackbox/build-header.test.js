import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";

test("every response class carries the build header, including auth failures", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-build-doc-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const buildDocument = path.join(dir, "index.html");
  await fs.writeFile(
    buildDocument,
    '<head><meta name="agentpier-build" content="0123456789abcdef"></head>',
  );
  const app = await applicationFixture(t, { buildDocument });
  const status = await fetch(`${app.url}/auth/status`);
  assert.equal(status.headers.get("x-agentpier-build"), "0123456789abcdef");
  assert.equal(status.headers.get("cache-control"), "no-store");
  const unauthenticated = await fetch(`${app.url}/api/state`);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("x-agentpier-build"), "0123456789abcdef");
  const crossOrigin = await fetch(`${app.url}/api/state`, {
    method: "POST",
    headers: { origin: "http://evil.example" },
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers.get("x-agentpier-build"), "0123456789abcdef");
});
