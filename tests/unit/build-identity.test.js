import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIdentity } from "../../server/http/build-identity.js";

const meta = (id) => `<head><meta name="agentpier-build" content="${id}"></head>`;

test("build identity follows rebuilds and tolerates missing metadata", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-build-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "index.html");
  const read = buildIdentity(file);
  assert.equal(read(), "");
  await fs.writeFile(file, meta("aaaaaaaaaaaaaaaa"));
  assert.equal(read(), "aaaaaaaaaaaaaaaa");
  await fs.writeFile(file, meta("bbbbbbbbbbbbbbbb"));
  const later = new Date(Date.now() + 5000);
  await fs.utimes(file, later, later);
  assert.equal(read(), "bbbbbbbbbbbbbbbb");
  await fs.writeFile(file, "<head></head>");
  await fs.utimes(file, new Date(Date.now() + 10000), new Date(Date.now() + 10000));
  assert.equal(read(), "");
});
