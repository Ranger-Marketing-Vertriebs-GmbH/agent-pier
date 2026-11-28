# Native memory qualification

The opt-in memory contract exercises pinned OpenClaw 2026.9.8 with AgentPier's
managed memory configuration, `NativeMemory`, assistant configuration updates,
and actual native model/tool execution. It uses the keyword provider `none`;
there is no embedding service or real model account in this qualification.
Local embeddings have a contract of their own, on the current pin
([Semantic memory search](#semantic-memory-search)).

## Running the contract

Point the environment variable at an installed, immutable runtime directory:

```sh
AGENTPIER_ASSISTANT_MEMORY_RUNTIME=/absolute/path/to/2026.9.8-node26.7.0-darwin-arm64 \
  node --test tests/integration/assistant-memory-contract.test.js
```

The test checks the installed package version against the managed runtime pin.
Only the Node binary and OpenClaw package are reused. Each test creates its own
temporary application database, runtime home, native state, configuration,
workspaces, loopback endpoint, and Gateway process. Cleanup stops the owned
Gateway and removes the temporary state. It never opens existing application
data, copies account credentials, contacts Telegram, or restarts a user's Gateway.
Ordinary `npm test` skips these two tests unless the variable is set.

On 2026-10-08, both contracts passed on macOS arm64 against the pinned
`2026.9.8-node26.7.0-darwin-arm64` runtime, with zero skips or failures. The local
run output is retained in `.cache/assistant-memory-qualification.tap`; temporary
native state was removed after completion.

## Covered behavior

The deletion test first indexes distinct synthetic markers in `MEMORY.md` and
`memory/qualification.md`, then confirms both are searchable through the product
adapter. Clearing `MEMORY.md` uses the native expected hash and the product save
path. A bounded condition poll verifies that the running Gateway stops returning
the cleared marker while preserving the separate workspace note. The test then
removes that separate note from its disposable workspace, stops the Gateway,
runs native `memory index --force --agent <id>` in the same isolated environment,
and starts a new Gateway process. Neither old marker may be found. Recreating
the note with different content and repeating re-index/restart must expose the
replacement marker without restoring either deleted marker.

The model-switch test creates two assistants with distinct native workspaces and
private synthetic notes. A deterministic HTTP model requests `memory_search`
through an actual native tool loop. The captured tool response must contain only
the appropriate assistant's marker. The test changes the first assistant from
configured model A to model B through `AssistantStore` and `AssistantConfig`,
opens a fresh conversation, and verifies that the HTTP request names model B and
its tool result still finds the same note. After a Gateway restart, file contents
remain unchanged, model B still executes for the first assistant, and model A
still executes for the second. Both tool responses and direct searches reject
the other assistant's marker.

## Boundaries

The model endpoint deliberately follows a scripted tool call. These assertions
prove configuration, file/index persistence, native tool plumbing, and workspace
isolation; they do not measure whether a real model chooses to remember or recall
the right information. They cover changing configured model IDs on one endpoint,
not changing embedding providers, endpoint protocols, accounts, or model vendors.

Clearing one file does not erase copies in other notes or conversation history.
Removing arbitrary notes is a test/operator filesystem action: AgentPier's note
editor exposes `MEMORY.md` and `USER.md`, not a workspace-wide deletion control.
The removed-file assertion explicitly includes a native forced index rebuild;
it does not promise synchronous erasure from every search reader. Database/WAL
forensics, backups, provenance-based `memory forget`, semantic embeddings,
cross-version migration, and other operating systems remain outside this contract.

## Semantic memory search

`tests/integration/assistant-semantic-memory-contract.test.js` runs the owner's
semantic memory search end to end on the pinned OpenClaw 2026.11.6, with the real
llama.cpp provider plugin from the runtime lock, the real pinned llama.cpp server
(release `b10809`) and the real EmbeddingGemma 300M model. There is no embedding
service and no model account; nothing leaves the machine. It drives the production
`SemanticMemory` service through its production wiring
(`server/application/semantic-memory-wiring.js`); only the Gateway restart is a plain
stop and start instead of the provider synchronization's.

```sh
AGENTPIER_SEMANTIC_MEMORY_CONTRACT_RUNTIME=/absolute/path/to/2026.11.6-node26.12.1-… \
AGENTPIER_EMBEDDING_ASSETS=/absolute/path/to/a/data/assistants \
  node --test --test-force-exit tests/integration/assistant-semantic-memory-contract.test.js
```

`AGENTPIER_EMBEDDING_ASSETS` names a folder whose `embeddings/` subfolder keeps the
pinned server and model between runs. What is missing there is downloaded once from
the pinned URLs (the server from GitHub, the 329 MB model from Hugging Face) and
checked against the pinned SHA-256; each test then works on its own copy in its own
temporary data directory. `scripts/provision-assistant-contracts.mjs` sets both
variables. Without them the tests skip.

The first test: with the setting off the compiled search is keyword search and a
German note about "Ferien an der Ostsee" is no hit for "Urlaub am Meer". Switching on
checks the assets, restarts the Gateway and rebuilds both agents' indexes; the
compiled configuration then names the local provider, the model file, the plugin and
the loopback provider entry. "Urlaub am Meer" finds the Ostsee note, an English
question finds a German note, each of two agents gets only its own notes (also for a
query that matches the other agent's note by word and by meaning), a deleted note
leaves the vector index and a new one enters it without a rebuild, an agent created
afterwards searches by meaning from its first note, and a Gateway restart (another
server port) keeps the indexes valid. Then the embeddings break while it is on (the
server is stopped and the model file replaced by bytes of the same size it cannot
load): the next memory search is answered by keyword alone and the state is
`degraded` (`EMBEDDINGS_UNAVAILABLE`), also with the file back; a missing model
file shows as `degraded` without a search; the repair installs the server anew,
checks the model, restarts and rebuilds, after which the state is `on` and the
search finds by meaning again. Switching off restores keyword search at once,
removes the model and leaves no embedding server behind. It reports the time of each
step, the search latency and the server's resident memory as diagnostics.

The second test: a model file the server cannot load (right size and receipt) makes
the rebuild's check fail (`openclaw memory status --deep` cannot embed); the setting
goes off with `MEMORY_INDEX_FAILED` and the same start rebuilds the keyword index,
so keyword search answers. Then, with the
setting really on, the journal of a rebuild that an AgentPier process left unfinished
switches it off as `INTERRUPTED`, and the next Gateway start rebuilds the keyword
index.

On 2026-11-27 both tests passed on macOS arm64 (Apple silicon, 117 s) and, in a
Debian 13 container, on Linux arm64 (94 s), each against a runtime provisioned
through the installer's step; the measurements are in the
[gateway guide](assistant-gateway.md#semantic-memory-search). Linux x64 runs in CI.

Where CI runs it:

- **Pull requests that touch the assistant runtime** (`assistant-runtime.yml`,
  `native-contracts`, Linux x64): yes, in the one shard of four that
  `scripts/assistant-contract-shards.json` assigns it to.
- **Nightly, on demand and before a release** (the same workflow through
  `full.yml`): yes, on Linux x64 and Linux arm64.
- **Merge queue** (`assistant-runtime-queue.yml`): no. That workflow names its core
  contracts itself and does not read the shard list.
- **Hosted macOS runners**: no; the shard's file list drops it there. The macOS
  build of the server computes on Metal, and a virtualized GPU is no qualification
  of that. Run it on Apple silicon before a release with the command above.

The shard that runs it caches `embeddings/` under a key of the server release and
the model digest (per runner OS and architecture), so a run with a cache hit
downloads nothing. On a miss `scripts/assistant-embedding-assets.mjs` downloads the
server from GitHub and the 329 MB model from Hugging Face. If that fails, a pull
request that changes semantic memory search (its files, the runtime manifest or
lock, the shard list, this workflow), or whose changes cannot be read, fails; every
other run gets a warning annotation "Semantic memory contract not run" and runs its
other contracts, so an outage of either host blocks no unrelated pull request and
no release. The shard list budgets 240 s for the file. Measured with the assets
present: 104 s on Linux arm64 and 121 s on Apple silicon. Only the shard that holds
it pays that time; the balancer evens the budgets out, so each of the four shards'
budget grows by about one minute. A cold cache adds the one download of about
342 MB to that shard.

Not covered: a real model deciding to search, retrieval quality beyond the fixed
examples, transcripts (they stay unindexed), an update between two runtimes that both
bundle the plugin (there is only one so far), and a rollback to 2026.11.3 with the
setting on (unit-tested: the start falls back to keyword search; that runtime never
had local embeddings, so its snapshot holds keyword indexes).

## Dreaming

Two contracts (variable `AGENTPIER_PROACTIVITY_CONTRACT_RUNTIME`) pin memory-core's
dreaming on OpenClaw 2026.10.7 with the compiled native configuration and the
owner's switch on, and a third pins it on the rollback targets (see the
[gateway guide](assistant-gateway.md#dreaming)):

- `tests/integration/assistant-dreaming-contract.test.js`: the compiled default
  schedules no sweep; switched on, a forced sweep takes each agent's own chats into
  its own `memory/.dreams/` corpus and dream notes only; a run rewrites its ingestion
  state wholesale, and a deleted chat, or one removed with `openclaw memory forget`
  (in a maintenance window since 2026.10.10), stays out of later runs; an hour change applies live during a running turn without
  a Gateway restart.
- `tests/integration/assistant-dreaming-scope-contract.test.js`: no per-agent lever
  keeps a temporary member out of the sweep; a shared agent dreams over every chat
  while `memory_search` returns no raw corpus; a sweep during a running turn neither
  blocks it nor opens agent sessions; the managed schedule fires without `cron.run`
  under the hardened heartbeat; under a symlinked data directory the sweep writes no
  corpus (macOS only).
- `tests/integration/assistant-dreaming-rollback-cross-version.test.js`
  (`AGENTPIER_ASSISTANT_PREVIOUS_RUNTIME`, run by the cross-version job for each
  rollback target): on the predecessor runtime the compiled section is accepted, the
  managed job follows the switch, a live hour change and the switch-off without a
  Gateway restart, a forced sweep keeps each agent to its own chats, the live
  `memory forget` is refused, and a deleted chat, forgotten in the maintenance window
  the offline command queue opens, leaves the corpus and stays out of later runs.

The archived transcript copy OpenClaw keeps after a deletion
(`session_transcript_archives` and the `.jsonl.deleted.*` files) is purged before the
forget runs; `assistant-chat-deletion-contract.test.js` covers that purge. The
session ids the archives name for the chat's key are read before it, and the forget
names each (`assistant-dreaming-forget.test.js`). Since OpenClaw 2026.10.10 the forget
refuses beside a running Gateway; the dreaming contract checks that refusal, runs the
hand-run forget in a window (`f.offline`) and the deletion through AgentPier's queue
(`OfflineCommands`), which stops the Gateway, forgets and starts it again (see
[Offline-only commands](assistant-gateway.md#offline-only-commands)). Queue
durability, batching, retries and the 2026.10.9 direct path are unit-tested
(`tests/unit/offline-commands.test.js`).
Cross-conversation recall (transcript indexing) is not offered and has no contract
here.
