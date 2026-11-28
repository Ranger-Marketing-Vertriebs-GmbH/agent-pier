export const assistantSemanticMemoryCopy = {
  title: "Semantic memory search",
  label: "Find notes by meaning",
  description: (size) =>
    `Memory search matches words by default. With this on, OpenClaw agents also find notes by their meaning, across wording and languages: a local embedding model (EmbeddingGemma 300M) runs on this computer, and no memory content leaves it. It needs a one-time download of ${size} and as much disk space, and about 550 to 750 MB of memory while agents search, which is freed after ten idle minutes. Hermes agents load their memory into every chat and have no memory search.`,
  states: {
    off: "Off",
    on: "On",
    downloading: "Downloading",
    rebuilding: "Rebuilding",
    degraded: "Not working",
    failed: "Off",
  },
  turnOn: "Turn on …",
  turnOnHint: "Downloads the model, restarts the agent service and rebuilds the indexes.",
  turnOff: "Turn off …",
  turnOffHint: "Restarts the agent service and goes back to keyword search.",
  running: "In progress",
  repair: "Repair …",
  repairHint:
    "Installs the server and the model again, restarts the agent service and rebuilds the indexes.",
  repairTitle: "Repair semantic memory search?",
  repairBody: (size) =>
    `AgentPier installs the llama.cpp server again, downloads the embedding model (${size}) if it is missing or changed, then restarts the agent service and rebuilds every agent's memory index. Running agent work is interrupted, and the agents are not available until the rebuild is done.`,
  repairConfirm: "Repair",
  degraded: (reason) =>
    `Semantic search is on but not working: memory search answers by keyword only. ${reason}`,
  degradedReasons: {
    EMBEDDINGS_UNAVAILABLE: "The embedding server did not answer the last memory search.",
    EMBEDDING_MODEL_MISSING: "The embedding model is no longer on this computer.",
    EMBEDDING_SERVER_MISSING: "The llama.cpp server is no longer on this computer.",
    EMBEDDING_SERVER_UNUSABLE:
      "The llama.cpp server does not start on this computer. On Linux it needs glibc 2.34 or newer (2.38 on arm64), OpenMP and OpenSSL 3 (Debian and Ubuntu: libgomp1 and libssl3).",
    RUNTIME_UPDATE_REQUIRED: "The OpenClaw runtime in use has no local embeddings.",
  },
  degradedReason: (code) => `Reason: ${code}.`,
  downloading: (received, total) =>
    `Downloading the embedding model: ${received} of ${total}`,
  phases: {
    stopping: "Stopping the agent service",
    starting: "Starting the agent service",
  },
  indexing: (done, total) =>
    total
      ? `Rebuilding the memory indexes: ${done} of ${total} agents`
      : "Rebuilding the memory indexes",
  pending: "On. The memory indexes are rebuilt when the agent service starts.",
  onTitle: "Turn on semantic memory search?",
  onBody: (size) =>
    `AgentPier downloads the embedding model (${size}) from Hugging Face, then restarts the agent service and rebuilds every agent's memory index. Running agent work is interrupted, and the agents are not available until the rebuild is done. A few notes take seconds; a large memory takes longer.`,
  onBodyFailure:
    "If the download or the rebuild fails, keyword search is restored and this stays off.",
  terms: "The model is Google's EmbeddingGemma. By turning this on you accept the",
  termsLink: "Gemma terms of use",
  onConfirm: "Download and turn on",
  offTitle: "Turn off semantic memory search?",
  offBody:
    "The agent service restarts and rebuilds every agent's memory index for keyword search. Running agent work is interrupted, and the agents are not available until the rebuild is done.",
  offBodyModel: "The downloaded model is removed.",
  offConfirm: "Turn off",
  unavailable: {
    EMBEDDING_PLATFORM_UNSUPPORTED:
      "Not available on this computer: there is no llama.cpp build for its platform.",
    RUNTIME_UPDATE_REQUIRED:
      "Needs the current OpenClaw runtime. Activate the update under OpenClaw updates first.",
    SERVICE_STOPPED: "Start the agent service first.",
  },
  failures: {
    INTERRUPTED:
      "AgentPier was restarted while this was being set up. Memory search works by keyword. Turn it on again to retry.",
    SERVICE_BUSY:
      "The agent service could not restart now: an update, a sign-in or an agent action is running. Nothing was changed. Try again later.",
    EMBEDDING_DOWNLOAD_FAILED:
      "The download failed. Check the internet connection and turn it on again; the download continues where it stopped.",
    EMBEDDING_DOWNLOAD_STALLED:
      "The download stalled. Check the internet connection and turn it on again; the download continues where it stopped.",
    EMBEDDING_CHECKSUM_MISMATCH:
      "The downloaded file did not have the expected checksum and was discarded. Turn it on again to download it once more.",
    EMBEDDING_DISK_SPACE: "There is not enough free disk space for the embedding model.",
    EMBEDDING_SERVER_UNUSABLE:
      "The llama.cpp server does not start on this computer. On Linux it needs glibc 2.34 or newer (2.38 on arm64), OpenMP and OpenSSL 3 (Debian and Ubuntu: libgomp1 and libssl3).",
    EMBEDDING_MODEL_MISSING:
      "The embedding model is no longer on this computer, so keyword search was restored. Turn it on again to download it.",
    EMBEDDING_SERVER_MISSING:
      "The llama.cpp server is no longer on this computer, so keyword search was restored. Turn it on again to install it.",
    EMBEDDING_MODEL_CHANGED:
      "The embedding model file on this computer had changed, so keyword search was restored. Turn it on again to download it.",
    RUNTIME_UPDATE_REQUIRED:
      "The OpenClaw runtime in use has no local embeddings, so keyword search was restored. Activate the current runtime, then turn it on again.",
    MEMORY_INDEX_FAILED:
      "The memory indexes could not be rebuilt with the embedding model. Keyword search was restored.",
    MEMORY_INDEX_UNVERIFIED:
      "The embedding model did not work on this computer, so the memory indexes could not be built with it. Keyword search was restored.",
    MEMORY_INDEX_TIMEOUT:
      "Rebuilding the memory indexes took too long and was stopped. Keyword search was restored.",
  },
  failed: (code) => `It could not be switched (${code}). Memory search works by keyword.`,
  errors: {
    SEMANTIC_MEMORY_CONFLICT: "This changed in the meantime. The current state is shown.",
    SEMANTIC_MEMORY_OPERATION_RUNNING: "A switch is already in progress.",
  },
  agentHint:
    "Semantic memory search is on: the search and the agent also find notes by meaning.",
};
