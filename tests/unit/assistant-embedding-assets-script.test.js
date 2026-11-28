import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  fetchEmbeddingAssets,
  fetchFailureIsFatal,
} from "../../scripts/assistant-embedding-assets.mjs";
import { contractShards } from "../../scripts/assistant-contract-shards.mjs";

// What CI does when the pinned embedding server or model cannot be fetched
// (scripts/assistant-embedding-assets.mjs): an outage of GitHub or Hugging Face
// never fails an unrelated run, and never lets a change of the feature pass unseen.
const base = "a".repeat(40);
const outage = () =>
  Promise.reject(Object.assign(Error("x"), { code: "EMBEDDING_DOWNLOAD_FAILED" }));

test("only a pull request that changes the feature fails on a fetch failure", () => {
  const fatal = (changed, from = base) => fetchFailureIsFatal({ base: from, changed });
  for (const file of [
    "server/features/assistants/runtimes/openclaw/semantic-memory.js",
    "server/features/assistants/runtimes/openclaw/openclaw-config/semantic-memory.js",
    "server/features/assistants/runtimes/openclaw/embedding-assets.js",
    "server/features/assistants/runtimes/openclaw/embedding-server.js",
    "server/features/assistants/runtimes/openclaw/memory-index.js",
    "server/features/assistants/runtimes/openclaw/runtime-manifest.js",
    "server/features/assistants/runtimes/openclaw/runtime-lock/package-lock.json",
    "server/application/semantic-memory-wiring.js",
    "tests/integration/assistant-semantic-memory-contract.test.js",
    "web/features/assistants/hub/SemanticMemoryGroup.jsx",
    "scripts/assistant-embedding-assets.mjs",
    "scripts/assistant-contract-shards.json",
    ".github/workflows/assistant-runtime.yml",
  ])
    assert.equal(fatal(["README.md", file]), true, file);
  // Another change of the assistant runtime is not held up by an outage.
  assert.equal(
    fatal(["server/features/assistants/assistant-store.js", "docs/agents.md"]),
    false,
  );
  assert.equal(fatal([]), false);
  // Changes that cannot be read count as a change of the feature.
  assert.equal(fatal(null), true);
  // Nightly, release and on demand have no base: the contract is left out, visibly.
  assert.equal(fatal(null, ""), false);
  assert.equal(fatal(["scripts/assistant-embedding-assets.mjs"], ""), false);
});

test("the assets are fetched once; a failure is an annotation with its stable code", async () => {
  const calls = [];
  const lines = [];
  const options = (fail, changed) => ({
    ensureServer: async ({ root }) => calls.push(["server", root]),
    ensureModel: async ({ root }) => {
      calls.push(["model", root]);
      if (fail) await outage();
    },
    changed: (sha) => {
      calls.push(["changed", sha]);
      return changed;
    },
    log: (line) => lines.push(line),
  });
  assert.deepEqual(await fetchEmbeddingAssets({ root: "/r", base }, options(false)), {
    available: true,
  });
  assert.deepEqual(calls, [
    ["server", "/r"],
    ["model", "/r"],
  ]);
  assert.deepEqual(lines, []);
  // An unrelated pull request: a warning, and the run goes on without the contract.
  let result = await fetchEmbeddingAssets(
    { root: "/r", base },
    options(true, ["docs/x.md"]),
  );
  assert.deepEqual(result, {
    available: false,
    fatal: false,
    code: "EMBEDDING_DOWNLOAD_FAILED",
  });
  assert.match(lines.at(-1), /^::warning title=Semantic memory contract not run::/);
  assert.match(lines.at(-1), /EMBEDDING_DOWNLOAD_FAILED/);
  // A pull request that changes the feature: an error.
  result = await fetchEmbeddingAssets(
    { root: "/r", base },
    options(true, ["server/features/assistants/runtimes/openclaw/semantic-memory.js"]),
  );
  assert.equal(result.fatal, true);
  assert.match(lines.at(-1), /^::error title=Embedding assets unavailable::/);
  // Without a base the changed files are not even read.
  calls.length = 0;
  result = await fetchEmbeddingAssets({ root: "/r" }, options(true, null));
  assert.equal(result.fatal, false);
  assert.equal(
    calls.some(([name]) => name === "changed"),
    false,
  );
  // An error without a stable code names none of its text.
  result = await fetchEmbeddingAssets(
    { root: "/r" },
    { ...options(false), ensureServer: () => Promise.reject(new Error("/private/path")) },
  );
  assert.equal(result.code, "FAILED");
  assert.equal(lines.at(-1).includes("/private/path"), false);
});

test("the workflow runs the contract on its Linux shard only with the assets in place", () => {
  const workflow = fs.readFileSync(
    new URL("../../.github/workflows/assistant-runtime.yml", import.meta.url),
    "utf8",
  );
  const queue = fs.readFileSync(
    new URL("../../.github/workflows/assistant-runtime-queue.yml", import.meta.url),
    "utf8",
  );
  const contract = "tests/integration/assistant-semantic-memory-contract.test.js";
  // The shard list drives assistant-runtime.yml alone; the merge queue names its
  // core contracts itself and this one is none of them.
  assert.ok(contractShards.files.includes(contract));
  assert.ok(workflow.includes("scripts/assistant-contract-shards.mjs"));
  assert.equal(queue.includes("assistant-contract-shards"), false);
  assert.equal(queue.includes("semantic-memory"), false);
  // Cached per pin, fetched by the script with the pull request's base, and left
  // out of the run when they are not there.
  assert.match(
    workflow,
    /key: embedding-assets-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-\$\{\{ steps\.runtime\.outputs\.embeddings \}\}/,
  );
  assert.match(
    workflow,
    /node scripts\/assistant-embedding-assets\.mjs\s+--root "\$RUNNER_TEMP\/agentpier-assistant-contracts\/assistants"\s+--base "\$BASE_SHA"/,
  );
  assert.match(
    workflow,
    /EMBEDDING_ASSETS: \$\{\{ steps\.assets\.outputs\.available \}\}/,
  );
  assert.match(
    workflow,
    /\[ "\$RUNNER_OS" != Linux \] \|\| \[ "\$EMBEDDING_ASSETS" != true \]/,
  );
});
