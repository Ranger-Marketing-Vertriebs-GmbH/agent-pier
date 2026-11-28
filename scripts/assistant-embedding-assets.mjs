import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "../server/lib/is-main-module.js";
import {
  ensureEmbeddingModel,
  ensureEmbeddingServer,
} from "../server/features/assistants/runtimes/openclaw/embedding-assets.js";
import { changedFiles } from "./assistant-runtime-paths.mjs";

// For the semantic memory contract in CI (.github/workflows/assistant-runtime.yml):
//
//   node scripts/assistant-embedding-assets.mjs --root <data>/assistants [--base <sha>]
//
// puts the pinned llama.cpp server and embedding model below <root>/embeddings,
// from the job's cache or, where the cache has none, from their pinned URLs (GitHub
// and Hugging Face), and writes `available=true|false` to $GITHUB_OUTPUT.
//
// An outage of those hosts must not fail runs that have nothing to do with the
// feature, and must never pass a change of the feature unseen:
// - a pull request (`--base`, its base commit) that changes the feature, or whose
//   changes cannot be read: the fetch failure fails the job;
// - any other run (another pull request, nightly, release, on demand): the contract
//   is left out of that run with a warning annotation that names the reason.

/** Paths whose change is a change of semantic memory search itself. */
export const embeddingFeaturePaths = [
  /semantic-?memory/i,
  /embedding-(assets|server)/,
  /memory-index/,
  /^server\/features\/assistants\/runtimes\/openclaw\/runtime-(manifest|lock|install)/,
  /^scripts\/(assistant-embedding-assets|assistant-contract-shards|provision-assistant-contracts)\./,
  /^\.github\/workflows\/assistant-runtime\.yml$/,
];

/**
 * Whether a failed fetch fails the job: `changed` are the files a pull request
 * changes (null when they cannot be read), `base` its base commit ("" outside one).
 */
export function fetchFailureIsFatal({ base, changed }) {
  if (!base) return false;
  if (!changed) return true;
  return changed.some((file) => embeddingFeaturePaths.some((path) => path.test(file)));
}

export async function fetchEmbeddingAssets(
  { root, base = "" },
  {
    ensureServer = ensureEmbeddingServer,
    ensureModel = ensureEmbeddingModel,
    changed = changedFiles,
    log = console.log,
  } = {},
) {
  try {
    await ensureServer({ root });
    await ensureModel({ root });
    return { available: true };
  } catch (error) {
    // Only the stable code: an error can carry a path.
    const code = /^[A-Z][A-Z0-9_]*$/.test(error?.code || "") ? error.code : "FAILED";
    const fatal = fetchFailureIsFatal({ base, changed: base ? changed(base) : null });
    log(
      fatal
        ? `::error title=Embedding assets unavailable::The pinned embedding server or model could not be fetched (${code}), and this pull request changes semantic memory search: its contract must run.`
        : `::warning title=Semantic memory contract not run::The pinned embedding server or model could not be fetched (${code}) and the cache holds none. The semantic memory contract is left out of this run; the other contracts run.`,
    );
    return { available: false, fatal, code };
  }
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs({
    options: { root: { type: "string" }, base: { type: "string" } },
  });
  if (!values.root || !path.isAbsolute(values.root))
    throw Error(
      "Usage: node scripts/assistant-embedding-assets.mjs --root <absolute-assistants-folder> [--base <sha>]",
    );
  fs.mkdirSync(values.root, { recursive: true, mode: 0o700 });
  const result = await fetchEmbeddingAssets({ root: values.root, base: values.base });
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `available=${result.available}\n`);
  if (result.available) console.log("Pinned embedding server and model are in place.");
  process.exitCode = result.fatal ? 1 : 0;
}
