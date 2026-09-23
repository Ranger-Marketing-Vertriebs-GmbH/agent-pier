import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { fixture, launch, descriptor } from "../helpers/memory.js";
import { applicationFixture } from "../helpers/application.js";
import { issue, connect } from "../helpers/session-mcp.js";
import { memoryResponse } from "../../server/features/memory/memory-protocol.js";
import { englishServerMessages as english } from "../../server/lib/i18n/catalog-en.js";

// The server keeps German catalog text for browsers; coding agents always read English.
const errorText = (result) => JSON.parse(result.content[0].text).error;

test("memory tools answer coding agents in English", async (t) => {
  const f = fixture(t);
  const config = descriptor("codex", await launch(f, "english", "codex"));
  const grant = JSON.parse(
    fs.readFileSync(config.args[config.args.indexOf("--capability") + 1]),
  );
  const response = memoryResponse(f.memory, grant, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "memory_write",
      arguments: { title: "x".repeat(300), content: "Content", requestId: "english" },
    },
  });
  assert.equal(response.result.isError, true);
  assert.equal(errorText(response.result), english.memory.invalidTitle);
});

test("session and artifact tools answer coding agents in English", async (t) => {
  const f = await applicationFixture(t);
  const client = await connect(t, f, await issue(f, { choices: true }));
  const run = await client.callTool({
    name: "run_get",
    arguments: { runId: randomUUID() },
  });
  assert.equal(run.isError, true);
  assert.equal(errorText(run), english.pipelines.runNotFound);
  const artifact = await client.callTool({
    name: "artifact_publish",
    arguments: { requestId: randomUUID(), title: "Report", sourcePath: "missing.html" },
  });
  assert.equal(artifact.isError, true);
  assert.equal(errorText(artifact), english.artifacts.ARTIFACT_INVALID_SOURCE);
});
