import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fixture, launch, descriptor, client, value } from "../helpers/memory.js";

for (const tool of ["codex", "claude", "opencode"])
  test(`${tool} Memory works without database filesystem permission`, async (t) => {
    const f = fixture(t);
    const prepared = await launch(f, `restricted-${tool}`, tool);
    const config = descriptor(tool, prepared);
    assert.equal(config.args[1], "--socket");
    assert.equal(config.args[3], "--capability");
    const source = fileURLToPath(new URL("../../", import.meta.url));
    const nodeArgs = [
      process.allowedNodeEnvironmentFlags.has("--permission")
        ? "--permission"
        : "--experimental-permission",
      `--allow-fs-read=${source}`,
      `--allow-fs-read=${config.args[4]}`,
      ...(process.allowedNodeEnvironmentFlags.has("--allow-net") ? ["--allow-net"] : []),
    ];
    execFileSync(
      process.execPath,
      [
        ...nodeArgs,
        "-e",
        `const assert=require("node:assert/strict");const fs=require("node:fs");assert.throws(()=>fs.readFileSync(process.argv[1]),{code:"ERR_ACCESS_DENIED"});`,
        path.join(f.dataDir, "memory", "memory.sqlite"),
      ],
      { stdio: "pipe" },
    );
    const c = client(t, config, { nodeArgs });
    await c.initialize();
    const saved = value(
      await c.call("memory_write", {
        requestId: "fixture-write-1",
        title: "Broker owns storage",
        content: "Only this project's authorized tools are exposed",
      }),
    );
    assert.equal(saved.projectId, prepared.memory.projectId);
    assert.equal(value(await c.call("memory_read", { id: saved.id })).title, saved.title);
    assert.equal(f.memory.read(prepared.memory.projectId, saved.id).title, saved.title);
    await f.integration.discard(`restricted-${tool}`);
    const denied = await c.call("memory_search", {});
    assert.ok(denied.error || denied.result?.isError);
    assert.equal(
      JSON.stringify(denied).includes(path.join(f.dataDir, "memory.sqlite")),
      false,
    );
  });

test("broker requires the presented secret and rejects stale clients after renewal", async (t) => {
  const f = fixture(t);
  const first = await launch(f, "renewed", "codex");
  const config = descriptor("codex", first);
  const c = client(t, config);
  await c.initialize();
  const saved = value(
    await c.call("memory_write", {
      requestId: "fixture-write-2",
      title: "Scoped",
      content: "Private fact",
    }),
  );
  await f.integration.discard("renewed");
  const next = descriptor("codex", await launch(f, "renewed", "codex"));
  assert.equal((await c.call("memory_read", { id: saved.id })).result.isError, true);
  const replacement = client(t, next);
  await replacement.initialize();
  assert.equal(
    value(await replacement.call("memory_read", { id: saved.id })).title,
    "Scoped",
  );
  const { memoryClient } = await import("../../server/features/memory/memory-client.js");
  const { default: fs } = await import("node:fs");
  const credential = JSON.parse(fs.readFileSync(next.args[4]));
  const stolenIdentity = path.join(f.root, "wrong.json");
  fs.writeFileSync(
    stolenIdentity,
    JSON.stringify({ ...credential, token: "0".repeat(64) }),
    { mode: 0o600 },
  );
  const wrong = memoryClient(next.args[2], stolenIdentity);
  const response = await wrong({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.ok(response.error);
  assert.equal(JSON.stringify(response).includes(credential.token), false);
  const other = await launch(f, "other", "claude");
  fs.writeFileSync(stolenIdentity, JSON.stringify({ ...credential, sessionId: "other" }));
  const mismatched = memoryClient(descriptor("claude", other).args[2], stolenIdentity);
  assert.ok((await mismatched({ jsonrpc: "2.0", id: 2, method: "initialize" })).error);
});
