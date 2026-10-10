# Native memory qualification

The opt-in memory contract exercises pinned OpenClaw 2026.9.8 with AgentPier's
managed memory configuration, `NativeMemory`, assistant configuration updates,
and actual native model/tool execution. It uses the keyword provider `none`;
there is no embedding service or real model account in this qualification.

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
forensics, backups, provenance-based `memory forget`, transcript indexing,
automatic consolidation, semantic embeddings, cross-version migration, and
other operating systems remain outside this contract.
