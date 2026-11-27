// Official npm distribution integrity verified 2026-11-22 (OpenClaw 2026.11.6 and its
// search plugins; the embedding plugin on 2026-11-27); nodejs.org SHASUMS256 for Node
// 26.12.1 verified 2026-10-23 (signed by release key
// 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356).
export const runtimeManifest = {
  version: "2026.11.6",
  // The directly previous pin, the only version an activation may roll back to (see
  // the release qualification); the managed team plugin must stay compatible with it.
  rollbackTargets: ["2026.11.3"],
  nodeVersion: "26.12.1",
  npmVersion: "11.20.0",
  dependencyLockSha256:
    "d10cc6cf1220dd6ea9ee1363149781033d1f6368c091c0563936adebc9ee3d96",
  // Security fixes for transitive packages OpenClaw pins exactly, as npm `overrides`
  // in the locked package.json; the lock must resolve every copy to these versions.
  // Remove an entry once the pinned OpenClaw ships the fixed version itself (2026.11.6
  // ships zod 4.6.7, so the zod override is gone).
  dependencyOverrides: {},
  packageUrl: "https://registry.npmjs.org/openclaw/-/openclaw-2026.11.6.tgz",
  packageIntegrity:
    "4MGjAMv8QlVrul3ZbCu8KjM7GhXfLdLzf0IrsO5QZ8LC3oYkduqs2rZiZpPDmTRpT6kXYke/OVaWrB+YmhBHLw==",
  // Official OpenClaw web search plugins (npm dist integrity, verified 2026-11-22).
  // They join the locked graph; a Gateway only loads one its configuration uses.
  searchPlugins: {
    duckduckgo: {
      id: "duckduckgo",
      package: "@openclaw/duckduckgo-plugin",
      version: "2026.11.6",
      integrity:
        "Q7FpnyV++qS6loE4mI+yEYg40Hla/R1ysS1ipaLYsDcZgDodw+1DVrukb0e3miKje5xbUcGHEioZmMc6Y/2XuA==",
    },
    perplexity: {
      id: "perplexity",
      package: "@openclaw/perplexity-plugin",
      version: "2026.11.6",
      integrity:
        "T7yMXABrF+GBX9CGAAFegmUeSUb3kQi3X267LkRnAK7xRw1ylElInDi4m8qoRVn8G+JVclyKg2EySr6TUMRzAg==",
    },
    brave: {
      id: "brave",
      package: "@openclaw/brave-plugin",
      version: "2026.11.6",
      integrity:
        "c7SgHOuhgqKn2o6tiPxCCBvIb4bW8OK4XI31Dy+ztrgHG624cxrsl0f5sa3tnPc2hTrJHYbwrqrJPUOPXBGaZQ==",
    },
  },
  // OpenClaw's llama.cpp provider: the plugin behind `memory.search.provider:
  // "local"` (npm dist integrity, verified 2026-11-27). It joins the locked graph; a
  // Gateway loads it only while the owner's semantic memory search is on.
  embeddingPlugin: {
    id: "llama-cpp",
    package: "@openclaw/llama-cpp-provider",
    version: "2026.11.6",
    integrity:
      "DyCvx93Z6JIBtcheaHKYd0dGyEST2mqCKYQ+CrORpS+yqKea2C+LrFWuAWFEu3c5d83kNZ3snMKWk5RY0bdpUg==",
  },
  // The llama.cpp server that plugin starts for embeddings: the build it was made
  // for (its own LLAMA_SERVER_RELEASE and archive digests), as GitHub release
  // archives; every SHA-256 was checked against the downloaded file on 2026-11-27.
  // AgentPier installs it itself (embedding-assets.js) and compiles its path, so the
  // Gateway never fetches a build.
  embeddingServer: {
    release: "b10809",
    commit: "5266f24da75dc449bd56cbed7addb9c8e4a6a73e",
    baseUrl: "https://github.com/ggml-org/llama.cpp/releases/download/b10809/",
    archives: {
      "darwin-arm64": {
        name: "llama-b10809-bin-macos-arm64.tar.gz",
        size: 11123196,
        sha256: "7d692df9e1e386e62f1c12b843903218041e6cd74c9415aa39a7ed3176f9eaa2",
      },
      "darwin-x64": {
        name: "llama-b10809-bin-macos-x64.tar.gz",
        size: 11175330,
        sha256: "13b34aa8a5d87341a21065a83f54a8167e1aaa6fe0d66065de01632a1ed64be6",
      },
      "linux-arm64": {
        name: "llama-b10809-bin-ubuntu-arm64.tar.gz",
        size: 13380118,
        sha256: "f2b7333971e1b7b42e9268bfdbfa30f5f56e2897156084d2251385df94aec358",
      },
      "linux-x64": {
        name: "llama-b10809-bin-ubuntu-x64.tar.gz",
        size: 16734586,
        sha256: "5e34434ddc6d03cd1584f403201aff0d4bd1a5793a72ff7e286532dfd1e4b941",
      },
    },
  },
  // The embedding model: EmbeddingGemma 300M (QAT, Q8_0) as GGUF, the plugin's own
  // default at the repository revision it pins (size and SHA-256 are the plugin's and
  // Hugging Face's LFS identity, checked against the downloaded file on 2026-11-27).
  // `file` is the cache name the plugin recognises as its default model, which gives
  // queries and notes EmbeddingGemma's task prefixes. Downloaded only when the owner
  // switches semantic memory search on; licensed under Google's Gemma Terms of Use.
  embeddingModel: {
    id: "embeddinggemma-300m-qat-q8_0",
    file: "hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf",
    url: "https://huggingface.co/ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/resolve/66f974f8cd48cc3b9c41c516b95508e75b4bee64/embeddinggemma-300m-qat-Q8_0.gguf?download=true",
    size: 328577056,
    sha256: "6fa0c02a9c302be6f977521d399b4de3a46310a4f2621ee0063747881b673f67",
    termsUrl: "https://ai.google.dev/gemma/terms",
  },
  nodeChecksums: {
    "darwin-arm64": "1901d539912c02afa10d1cc126943a8855a7eedebe830119463470db5e6c59e8",
    "darwin-x64": "b85c2ea4420ad0bc4abf2dc6cf1f55130ed681f1cabf60cf3f526e4c9e2712ff",
    "linux-arm64": "a6c01af459dd8972ab3fb08ee5da81244d26ba8c4944a62d5bbba8c597ae154f",
    "linux-x64": "0fd1eb7770598f52a21995edf6ed35fc690400fa437c2386af329519e9143132",
  },
};
/**
 * Whether this AgentPier can run an OpenClaw version: the pin and its rollback
 * targets only (the managed team plugin refuses every other one). An installation
 * still on another version waits for the owner to activate the pin.
 */
export const runnableVersion = (version) =>
  version === runtimeManifest.version ||
  runtimeManifest.rollbackTargets.includes(version);
