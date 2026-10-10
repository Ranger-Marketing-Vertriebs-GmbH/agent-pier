# Assistant provider qualification

The central endpoint adapter has deterministic native Gateway coverage. That
coverage does not establish compatibility with a real inference engine or deployment.
Keep these two kinds of evidence separate when reporting support.

## Observed evidence

On October 10, 2026, Ollama and llama.cpp were qualified on a Mac mini (Apple M4 Pro,
48 GB) against the pinned OpenClaw 2026.9.8 runtime. Both engines ran locally without
keys; existing personal accounts and private runtime state were not imported.

| Target                    | Actual inference qualification | Engine and model                                                                     | Limitation                                                                       |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Ollama                    | Passed (live runner, 1/1)      | Ollama 0.40.2, `qwen3:4b`, context 32,768 (set via `OLLAMA_CONTEXT_LENGTH`), keyless | The connection test cannot read the loaded context; confirm it manually.         |
| llama.cpp                 | Passed (live runner, 1/1)      | llama.cpp build 11429, `Qwen2.5-3B-Instruct` Q4_K_M, `--jinja -c 32768`, keyless     | Small models may store notes outside `memory/`, so memory search misses them.    |
| Azure OpenAI / Foundry v1 | Not performed                  | —                                                                                    | No authorized deployment URL, model/deployment ID, and credential were provided. |

The same day, an isolated AgentPier instance of this branch was driven through its
real web UI: both endpoints were added and tested under Accounts (all three protocols
available), agents were enabled and created per engine, and chat replies,
`session_status` tool calls and memory writes/searches completed. Coding sessions via
the same connections also answered through the session chat: OpenCode with Ollama
(Chat Completions), Codex with llama.cpp (Responses) and Claude Code with llama.cpp
(Messages). Turn latency was about 9 s for plain replies and 30–60 s for tool turns
with `qwen3:4b`, which reasons before answering.

On October 8, 2026, no running local inference endpoint or authorized Azure
deployment was available to the qualification run.

This discovery is limited to the inspected host and conventional installation
locations. It does not establish that no endpoint exists elsewhere. No engine or
multi-gigabyte model download was initiated, and existing services were not changed.

The deterministic `assistant-provider-contract.test.js` uses the actual pinned
Gateway and a simulated SSE model service. It checks streamed tool-call framing,
tool-result continuation, request paths, keyless/Bearer/custom authentication,
rotation/removal, and secret exposure. Its schedule counterpart covers native cron
behavior after rotation/restart and revocation. These are protocol contract tests,
not evidence of Ollama, llama.cpp, or Azure model behavior.

## Repeatable actual endpoint check

`tests/integration/assistant-provider-live.test.js` is skipped unless explicitly
enabled. It sends one assistant message to the selected endpoint; native tool
continuation and provider retries can generate multiple billable model requests.
It uses a fresh temporary central connection, assistant, workspace, and Gateway,
then removes that state. The only allowed tool is the read-only `session_status`.
It never imports an installed runtime's accounts, configuration, conversations,
channels, or schedules, and never starts or stops the inference service itself.

Provide a pinned immutable runtime installation, an already running authorized
endpoint, the exact model/deployment ID, and its actual configured context window:

```sh
AGENTPIER_ASSISTANT_PROVIDER_RUNTIME=/absolute/path/to/pinned-runtime \
AGENTPIER_ASSISTANT_LIVE=1 \
AGENTPIER_ASSISTANT_LIVE_PRESET=ollama \
AGENTPIER_ASSISTANT_LIVE_URL=http://127.0.0.1:11434/v1 \
AGENTPIER_ASSISTANT_LIVE_MODEL=YOUR_INSTALLED_TOOL_MODEL \
AGENTPIER_ASSISTANT_LIVE_CONTEXT=32768 \
node --test tests/integration/assistant-provider-live.test.js
```

Use `llamacpp` for that preset or `custom` for Azure and other compatible services.
Context must be at least 4,000 tokens and reflect the running model's configuration.
`AGENTPIER_ASSISTANT_LIVE_OUTPUT` defaults to 2,048 and accepts 1,024–4,096 tokens.
The turn wait is bounded to 150 seconds; model startup and slow local inference can
exceed it. A failed or timed-out test is not a passing qualification.

For a keyed endpoint, set `AGENTPIER_ASSISTANT_LIVE_KEY_FILE` to a private regular
file containing the key. The file must have no group/other permissions, for example
mode `0600`. Do not put the key directly into a shell command. The test never writes
to that file. For Azure v1, use the `/openai/v1` base URL, the deployment name as the
model, and `AGENTPIER_ASSISTANT_LIVE_AUTH_HEADER=api-key`. Leaving the header unset
selects Bearer authentication. The endpoint is contacted directly, preserving the
native adapter's host and authentication behavior.

A passing run requires a successful native `session_status` receipt, the requested
final assistant reply, at least one downstream Gateway streaming delta, and no key
in history, capability responses, redacted configuration, or runtime logs. It does
not packet-capture upstream SSE or prove arbitrary tool quality, parallel calls,
large contexts, reconnect behavior, long-running inference, or every model offered
by the service. The deterministic suite covers exact upstream wire formatting.

Record actual engine version, model/deployment ID, configured limits, authentication
mode, date, command outcome, and observed limitations after each real run. Do not
record credentials, private prompts, account identifiers, or raw runtime logs.
An unexecuted live check and a check against a simulated server must never be listed
as real provider qualification.
