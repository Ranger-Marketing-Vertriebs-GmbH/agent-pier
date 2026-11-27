import path from "node:path";
import { lastCdpOffset } from "./browser-profiles.js";

// Semantic memory search on OpenClaw (docs/assistant-gateway.md, "Semantic memory
// search"; verified against 2026.11.6, its docs/plugins/llama-cpp.md and
// docs/reference/memory-config.md). OpenClaw's memory search embeds notes and queries
// with `memory.search.provider: "local"`, which the llama.cpp provider plugin
// (`llama-cpp`, @openclaw/llama-cpp-provider) serves through a llama.cpp server it
// starts on demand as a child of the Gateway (`models.providers.llama-cpp.
// localService`) and stops after ten idle minutes. Everything stays on this machine:
// the server listens on loopback only and the model is a local file.
//
// Left to itself the plugin would download both the server build and the model. It
// does neither here:
// - `localService.command` is not the plugin's own managed installation path, so it
//   never installs or restores a build (it only does that for its managed path);
// - `memory.search.local.modelPath` is an absolute local file, which the plugin only
//   checks to be a GGUF file (remote sources alone are downloaded);
// - `fallback: "none"`: no other embedding provider takes over.
// AgentPier installs both itself, pinned and verified (embedding-assets.js).

/** OpenClaw's plugin id and the model provider it registers. */
export const embeddingPlugin = "llama-cpp";
/** The embedding server's loopback port: the first one after the browsers' CDP range. */
export const embeddingPortOffset = lastCdpOffset + 1;
// The plugin's own idle shutdown (its LLAMA_CPP_IDLE_STOP_MS): the server and the
// model leave memory ten minutes after the last search or index update.
const idleStopMs = 600000;
// A cold start loads the model; the first one on macOS also waits for the system's
// check of a new executable.
const readyTimeoutMs = 120000;
// Writes the server's pid for AgentPier, then becomes the server (same pid), so a
// server that outlived a killed Gateway can be found and stopped (embedding-server.js).
const startScript = 'echo "$$" > "$1" && shift && exec "$@"';

/**
 * The Gateway sections of semantic memory search, or null while it is off (keyword
 * search, the default). `semanticMemory` is what SemanticMemory.compiled() answers:
 * `{ plugin: { id, directory }, command, model, modelCacheDir, preset, pidFile }`,
 * every path absolute and verified. Pure.
 * - `plugin`: the plugin to allow and load.
 * - `search`: the keys to merge into `memory.search`.
 * - `provider`: `models.providers.llama-cpp`.
 */
export function semanticMemorySections({ semanticMemory, port }) {
  if (!semanticMemory) return null;
  const { plugin, command, model, modelCacheDir, preset, pidFile } = semanticMemory;
  for (const file of [plugin?.directory, command, model, modelCacheDir, preset, pidFile])
    if (typeof file !== "string" || !path.isAbsolute(file))
      throw new TypeError("Semantic memory search needs absolute paths.");
  if (plugin.id !== embeddingPlugin)
    throw new TypeError("Semantic memory search needs the llama.cpp plugin.");
  const origin = `http://127.0.0.1:${port + embeddingPortOffset}`;
  return {
    plugin,
    search: { provider: "local", fallback: "none", local: { modelPath: model } },
    provider: {
      baseUrl: `${origin}/v1`,
      api: "openai-completions",
      // No chat model: the provider serves embeddings only.
      models: [],
      // The folder that makes the plugin recognise its default model by file name
      // (EmbeddingGemma's query and document prefixes, and the index identity).
      params: { modelCacheDir },
      localService: {
        command: "/bin/sh",
        args: [
          "-c",
          startScript,
          "agentpier-embedding-server",
          pidFile,
          command,
          "--host",
          "127.0.0.1",
          "--port",
          String(port + embeddingPortOffset),
          "--models-preset",
          preset,
          "--models-max",
          "1",
          "--no-ui",
        ],
        healthUrl: `${origin}/health`,
        readyTimeoutMs,
        idleStopMs,
      },
    },
  };
}

/**
 * Applies semanticMemorySections to a configuration whose `memory.search` and plugin
 * allow list the compiler has written. The provider entry is compiler-owned: one an
 * earlier start wrote is removed while semantic search is off. Without sections the
 * configuration is otherwise untouched (keyword search).
 */
export function applySemanticMemory(config, sections) {
  if (config.models?.providers?.[embeddingPlugin]) {
    const { [embeddingPlugin]: _stale, ...providers } = config.models.providers;
    config.models = { ...config.models, providers };
  }
  if (!sections) return config;
  config.plugins.allow = [...(config.plugins.allow || []), sections.plugin.id];
  config.plugins.load = {
    ...config.plugins.load,
    paths: [...(config.plugins.load?.paths || []), sections.plugin.directory],
  };
  config.memory = {
    ...config.memory,
    search: { ...config.memory?.search, ...sections.search },
  };
  config.models = {
    ...config.models,
    providers: { ...config.models?.providers, [embeddingPlugin]: sections.provider },
  };
  return config;
}

/**
 * `config` (an openclaw.json compiled with local embeddings) as the same start
 * compiles it for keyword search: the plugin leaves the allow list and the load
 * paths, `memory.search` names no embedding provider and the llama.cpp provider is
 * removed. For the fallback of a failed index rebuild alone (SemanticMemory): the
 * Gateway then starts on keyword search. Returns a copy.
 */
export function withoutSemanticMemory(config) {
  const next = applySemanticMemory(structuredClone(config), null);
  if (!compiledSemantic(next)) return next;
  const loaded = (entry) => /[\\/]@openclaw[\\/]llama-cpp-provider$/.test(entry);
  next.plugins.allow = (next.plugins.allow || []).filter((id) => id !== embeddingPlugin);
  const paths = (next.plugins.load?.paths || []).filter((entry) => !loaded(entry));
  if (paths.length) next.plugins.load = { ...next.plugins.load, paths };
  else if (next.plugins.load) delete next.plugins.load.paths;
  const { fallback: _fallback, local: _local, ...search } = next.memory.search;
  next.memory.search = { ...search, provider: "none" };
  return next;
}

/** Whether `config` (an openclaw.json) searches memory with local embeddings. */
export const compiledSemantic = (config) => config?.memory?.search?.provider === "local";

/**
 * `config` with memory search switched on for every agent AgentPier manages (an
 * entry with its own `memory.search`), for the offline index rebuild alone: OpenClaw's
 * `memory index` skips an agent whose memory is off, and such an agent's old index
 * would pause its search once its memory is switched on again. Returns a copy.
 */
export function indexEveryAgent(config) {
  const next = structuredClone(config);
  for (const entry of Object.values(next.agents?.entries || {}))
    if (entry?.memory?.search && typeof entry.memory.search === "object")
      entry.memory.search.enabled = true;
  return next;
}
