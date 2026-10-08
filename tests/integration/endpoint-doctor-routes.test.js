import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { Doctor } from "../../server/features/operations/doctor.js";

const azureLike = {
  preset: "custom",
  openaiBaseUrl: "https://llm.example/v1",
  anthropicBaseUrl: null,
  protocols: { messages: false, responses: true, chatCompletions: true },
  authHeader: "api-key",
  models: [],
  lastTest: null,
  routing: { opencode: "responses" },
};
// Assembled at runtime so the secret scanner does not treat the probe as a credential.
const PROBE_KEY = ["doctor", "leak", "probe", "0123456789"].join("-");

function setup(t) {
  const dataDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-doctor-routes-")),
  );
  fs.chmodSync(dataDir, 0o700);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, connections: new ProviderConnections({ dataDir }) };
}
const run = (dataDir) =>
  new Doctor({
    dataDir,
    command: async () => ({ code: 0, stdout: "fixture 1.0.0" }),
    ptyCheck: async () => true,
  }).run({ scope: "host" });

test("endpoint summaries list the resolved routes and the unverified Azure header case", async (t) => {
  const { dataDir, connections } = setup(t);
  const { id } = connections.create({
    name: "Azure",
    providerId: "endpoint",
    apiKey: PROBE_KEY,
    endpoint: azureLike,
  });
  const report = await run(dataDir);
  assert.equal(JSON.stringify(report).includes(PROBE_KEY), false);
  const check = report.checks.find((c) => c.id === `provider-connection.${id}`);
  assert.match(
    check.summary,
    /routes claude=adapter:responses, codex=native:responses, opencode=sdk:responses/,
  );
  assert.match(check.summary, /blank Authorization header next to api-key/);
});

test("running adapter sessions appear in the host report", async (t) => {
  const { dataDir } = setup(t);
  const dir = path.join(dataDir, "sessions");
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, "s1.json"),
    JSON.stringify({
      id: "s1",
      name: "Nightly",
      tool: "codex",
      status: "running",
      adapterGeneration: "g1",
      provider: { route: { mode: "adapter", source: "chatCompletions" } },
    }),
  );
  fs.writeFileSync(
    path.join(dir, "s1.adapter.json"),
    JSON.stringify({
      version: 1,
      generation: "g1",
      requests: { "/v1/messages": 2 },
      prompt: "leak-probe prompt text",
      token: "leak-probe-token",
    }),
  );
  const report = await run(dataDir);
  assert.equal(JSON.stringify(report).includes("leak-probe"), false);
  const check = report.checks.find((c) => c.id === "adapter-session.s1");
  assert.equal(check.status, "ok");
  assert.match(
    check.summary,
    /"Nightly": Codex via adapter \(chatCompletions\): 2 request\(s\)/,
  );
});
