import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ProviderCatalog } from "../../server/features/providers/provider-catalog.js";
import { prepareProviderLaunch } from "../../server/features/providers/provider-launch.js";
import { validateEndpoint } from "../../server/features/providers/endpoint-config.js";

const codex = spawnSync("codex", ["--version"], { encoding: "utf8" });
const installed = codex.status === 0;

test(
  "the installed Codex CLI accepts the generated endpoint model catalog",
  { skip: installed ? false : "codex CLI is not installed" },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-codex-catalog-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const endpoint = validateEndpoint({
      preset: "custom",
      // Port 9 (discard) is never served, so Codex fails on the network, not on config.
      openaiBaseUrl: "http://127.0.0.1:9/v1",
      anthropicBaseUrl: null,
      protocols: { messages: false, responses: true, chatCompletions: false },
      authHeader: null,
      models: [
        {
          modelId: "fixture-model",
          label: "Fixture",
          contextTokens: 32768,
          outputTokens: null,
          source: "manual",
          contextEdited: true,
        },
      ],
      lastTest: null,
    });
    const launch = prepareProviderLaunch(
      {
        kind: "managed",
        tool: "codex",
        provider: { id: "endpoint", modelId: "fixture-model" },
      },
      null,
      { command: "codex", args: [], env: { PATH: process.env.PATH, HOME: root } },
      { root, catalog: new ProviderCatalog(), endpoint, connectionName: "Fixture" },
    );
    const result = spawnSync(
      "codex",
      ["exec", "--skip-git-repo-check", ...launch.args, "ping"],
      { cwd: root, env: launch.env, encoding: "utf8", timeout: 20000 },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(/model_catalog_json|unknown variant/i.test(output), false, output);
  },
);
